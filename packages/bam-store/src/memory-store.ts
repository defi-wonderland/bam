import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchRow,
  BatchStatus,
  BatchesQuery,
  MessageRow,
  MessagesQuery,
  NonceTrackerRow,
  PendingKey,
  ReaderCursorRow,
  StoreTxn,
  StoreTxnPendingRow,
} from './types.js';

class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Composite key (author, nonce) encoded as a single map key. */
function pendingKey(sender: Address, nonce: bigint): string {
  return `${sender.toLowerCase()}:${nonce.toString()}`;
}

interface State {
  messages: Map<string, MessageRow>;
  batches: Map<Bytes32, BatchRow>;
  tagSeq: Map<Bytes32, number>;
  nonces: Map<Address, NonceTrackerRow>;
  readerCursor: Map<number, ReaderCursorRow>;
}

function newState(): State {
  return {
    messages: new Map(),
    batches: new Map(),
    tagSeq: new Map(),
    nonces: new Map(),
    readerCursor: new Map(),
  };
}

export class MemoryBamStore implements BamStore {
  private readonly lock = new AsyncLock();
  private readonly state: State = newState();

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const snapshot: State = {
        messages: new Map(this.state.messages),
        batches: new Map(this.state.batches),
        tagSeq: new Map(this.state.tagSeq),
        nonces: new Map(this.state.nonces),
        readerCursor: new Map(this.state.readerCursor),
      };
      const txn = this.makeTxn();
      try {
        return await fn(txn);
      } catch (err) {
        restoreInto(this.state, snapshot);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    // nothing to release
  }

  /** Test hook — unsafe outside tests. */
  _unsafeClear(): void {
    this.state.messages.clear();
    this.state.batches.clear();
    this.state.tagSeq.clear();
    this.state.nonces.clear();
    this.state.readerCursor.clear();
  }

  private makeTxn(): StoreTxn {
    const { messages, batches, tagSeq, nonces, readerCursor } = this.state;

    return {
      // ── old Poster-facing pending CRUD (bridged to unified messages) ──
      insertPending(row: StoreTxnPendingRow): void {
        const k = pendingKey(row.sender, row.nonce);
        const existing = messages.get(k);
        if (existing) {
          // The reorg watcher re-enqueues a row whose prior status was
          // `reorged`. Duplicates (from the nonce-replay-across-batchers
          // case) may also be overwritten. Any live status rejects.
          if (existing.status !== 'reorged' && existing.status !== 'duplicate') {
            throw new Error('insertPending: duplicate (sender, nonce)');
          }
        }
        messages.set(k, {
          messageId: null,
          author: row.sender,
          nonce: row.nonce,
          contentTag: row.contentTag,
          contents: new Uint8Array(row.contents),
          signature: new Uint8Array(row.signature),
          messageHash: row.messageHash,
          status: 'pending',
          batchRef: null,
          ingestedAt: row.ingestedAt,
          ingestSeq: row.ingestSeq,
          blockNumber: null,
          txIndex: null,
          messageIndexWithinBatch: null,
        });
      },

      getPendingByKey(key: PendingKey): StoreTxnPendingRow | null {
        const r = messages.get(pendingKey(key.sender, key.nonce));
        if (!r || r.status !== 'pending') return null;
        return toPending(r);
      },

      listPendingByTag(
        tag: Bytes32,
        limit?: number,
        sinceSeq?: number
      ): StoreTxnPendingRow[] {
        const out: StoreTxnPendingRow[] = [];
        for (const r of messages.values()) {
          if (r.status !== 'pending') continue;
          if (r.contentTag !== tag) continue;
          if (sinceSeq !== undefined && (r.ingestSeq ?? 0) <= sinceSeq) continue;
          out.push(toPending(r));
        }
        out.sort((a, b) => a.ingestSeq - b.ingestSeq);
        return typeof limit === 'number' ? out.slice(0, limit) : out;
      },

      listPendingAll(limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const out: StoreTxnPendingRow[] = [];
        for (const r of messages.values()) {
          if (r.status !== 'pending') continue;
          if (sinceSeq !== undefined && (r.ingestSeq ?? 0) <= sinceSeq) continue;
          out.push(toPending(r));
        }
        out.sort((a, b) => {
          if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt - b.ingestedAt;
          return a.ingestSeq - b.ingestSeq;
        });
        return typeof limit === 'number' ? out.slice(0, limit) : out;
      },

      countPendingByTag(tag: Bytes32): number {
        let n = 0;
        for (const r of messages.values()) {
          if (r.status === 'pending' && r.contentTag === tag) n++;
        }
        return n;
      },

      nextIngestSeq(tag: Bytes32): number {
        const cur = tagSeq.get(tag) ?? 0;
        const next = cur + 1;
        tagSeq.set(tag, next);
        return next;
      },

      // ── nonce tracker ────────────────────────────────────────────────
      getNonce(sender: Address): NonceTrackerRow | null {
        const row = nonces.get(sender.toLowerCase() as Address);
        return row ? { ...row } : null;
      },
      setNonce(row: NonceTrackerRow): void {
        const key = row.sender.toLowerCase() as Address;
        nonces.set(key, { ...row, sender: key });
      },

      // ── unified-schema lifecycle transitions ─────────────────────────
      markSubmitted(keys: PendingKey[], batchRef: Bytes32): void {
        for (const k of keys) {
          const mk = pendingKey(k.sender, k.nonce);
          const r = messages.get(mk);
          if (!r) throw new Error(`markSubmitted: no row for (${k.sender}, ${k.nonce})`);
          if (r.status !== 'pending') {
            throw new Error(
              `markSubmitted: (${k.sender}, ${k.nonce}) status=${r.status}, expected pending`
            );
          }
          messages.set(mk, { ...cloneMessage(r), status: 'submitted', batchRef });
        }
      },

      upsertObserved(row: MessageRow): void {
        const k = pendingKey(row.author, row.nonce);
        const existing = messages.get(k);
        // Idempotency: a second observation of the same (author, nonce)
        // with matching messageHash is a no-op merge. A mismatching
        // messageHash is the "duplicate" case the Reader surfaces via
        // markDuplicate; upsertObserved itself doesn't invent that
        // transition — it refuses to overwrite a confirmed row.
        if (existing) {
          if (existing.status === 'confirmed' && existing.messageHash !== row.messageHash) {
            throw new Error(
              'upsertObserved: existing confirmed row has a different messageHash — caller must call markDuplicate'
            );
          }
          if (existing.status === 'confirmed' && existing.messageHash === row.messageHash) {
            return; // idempotent no-op
          }
        }
        messages.set(k, cloneMessage(row));
      },

      markDuplicate(messageHash: Bytes32): void {
        for (const [k, r] of messages) {
          if (r.messageHash === messageHash && r.status !== 'confirmed') {
            messages.set(k, { ...cloneMessage(r), status: 'duplicate' });
            return;
          }
        }
        throw new Error(`markDuplicate: no non-confirmed row with messageHash=${messageHash}`);
      },

      markReorged(txHash: Bytes32, invalidatedAt: number): void {
        const b = batches.get(txHash);
        if (!b) throw new Error(`markReorged: no batch for tx_hash=${txHash}`);
        batches.set(txHash, { ...b, status: 'reorged', invalidatedAt });
        // Cascade: every confirmed row under this batch flips to
        // reorged with the same invalidatedAt.
        for (const [k, r] of messages) {
          if (r.batchRef === txHash && r.status === 'confirmed') {
            messages.set(k, { ...cloneMessage(r), status: 'reorged' });
          }
        }
      },

      // ── unified-schema reads (T005) ──────────────────────────────────
      listMessages(query: MessagesQuery): MessageRow[] {
        const out: MessageRow[] = [];
        for (const r of messages.values()) {
          if (query.contentTag !== undefined && r.contentTag !== query.contentTag) continue;
          if (query.author !== undefined && r.author.toLowerCase() !== query.author.toLowerCase()) continue;
          if (query.status !== undefined && r.status !== query.status) continue;
          if (query.batchRef !== undefined && r.batchRef !== query.batchRef) continue;
          if (query.sinceBlock !== undefined) {
            if (r.blockNumber === null) continue;
            if (BigInt(r.blockNumber) < query.sinceBlock) continue;
          }
          if (query.cursor !== undefined) {
            if (!afterCursor(r, query.cursor)) continue;
          }
          out.push(cloneMessage(r));
        }
        // Chain-derived ordering: (blockNumber, txIndex, messageIndexWithinBatch).
        // Rows with null coordinates sort to the end in a stable order
        // that still obeys ingestSeq (so Poster-side lists stay FIFO).
        out.sort(compareByChainCoord);
        return typeof query.limit === 'number' ? out.slice(0, query.limit) : out;
      },

      getByMessageId(messageId: Bytes32): MessageRow | null {
        for (const r of messages.values()) {
          if (r.messageId === messageId) return cloneMessage(r);
        }
        return null;
      },

      getByAuthorNonce(author: Address, nonce: bigint): MessageRow | null {
        const r = messages.get(pendingKey(author, nonce));
        return r ? cloneMessage(r) : null;
      },

      // ── unified-schema batch CRUD (T005) ─────────────────────────────
      upsertBatch(row: BatchRow): void {
        batches.set(row.txHash, { ...row });
      },

      updateBatchStatus(
        txHash: Bytes32,
        status: BatchStatus,
        opts?: {
          blockNumber?: number | null;
          txIndex?: number | null;
          replacedByTxHash?: Bytes32 | null;
          invalidatedAt?: number | null;
        }
      ): void {
        const b = batches.get(txHash);
        if (!b) throw new Error(`updateBatchStatus: no batch for tx_hash=${txHash}`);
        batches.set(txHash, {
          ...b,
          status,
          blockNumber: opts?.blockNumber === undefined ? b.blockNumber : opts.blockNumber,
          txIndex: opts?.txIndex === undefined ? b.txIndex : opts.txIndex,
          replacedByTxHash:
            opts?.replacedByTxHash === undefined ? b.replacedByTxHash : opts.replacedByTxHash,
          invalidatedAt:
            opts?.invalidatedAt === undefined ? b.invalidatedAt : opts.invalidatedAt,
        });
      },

      listBatches(query: BatchesQuery): BatchRow[] {
        const out: BatchRow[] = [];
        for (const b of batches.values()) {
          if (query.contentTag !== undefined && b.contentTag !== query.contentTag) continue;
          if (query.chainId !== undefined && b.chainId !== query.chainId) continue;
          if (query.status !== undefined && b.status !== query.status) continue;
          if (query.sinceBlock !== undefined) {
            if (b.blockNumber === null) continue;
            if (BigInt(b.blockNumber) < query.sinceBlock) continue;
          }
          out.push({ ...b });
        }
        out.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
        return typeof query.limit === 'number' ? out.slice(0, query.limit) : out;
      },

      // ── reader cursor (T005) ─────────────────────────────────────────
      getCursor(chainId: number): ReaderCursorRow | null {
        const row = readerCursor.get(chainId);
        return row ? { ...row } : null;
      },
      setCursor(row: ReaderCursorRow): void {
        readerCursor.set(row.chainId, { ...row });
      },
    };
  }
}

export function createMemoryStore(): BamStore {
  return new MemoryBamStore();
}

// ─────────────────────────────────────────────────────────────────────────
// Bridge helpers
// ─────────────────────────────────────────────────────────────────────────

function toPending(r: MessageRow): StoreTxnPendingRow {
  return {
    contentTag: r.contentTag,
    sender: r.author,
    nonce: r.nonce,
    contents: new Uint8Array(r.contents),
    signature: new Uint8Array(r.signature),
    messageHash: r.messageHash,
    ingestedAt: r.ingestedAt ?? 0,
    ingestSeq: r.ingestSeq ?? 0,
  };
}

function cloneMessage(r: MessageRow): MessageRow {
  return {
    ...r,
    contents: new Uint8Array(r.contents),
    signature: new Uint8Array(r.signature),
  };
}

function afterCursor(r: MessageRow, c: { blockNumber: number; txIndex: number; messageIndexWithinBatch: number }): boolean {
  if (r.blockNumber === null || r.txIndex === null || r.messageIndexWithinBatch === null) return false;
  if (r.blockNumber !== c.blockNumber) return r.blockNumber > c.blockNumber;
  if (r.txIndex !== c.txIndex) return r.txIndex > c.txIndex;
  return r.messageIndexWithinBatch > c.messageIndexWithinBatch;
}

function compareByChainCoord(a: MessageRow, b: MessageRow): number {
  const aHas = a.blockNumber !== null;
  const bHas = b.blockNumber !== null;
  if (aHas && bHas) {
    if (a.blockNumber !== b.blockNumber) return (a.blockNumber as number) - (b.blockNumber as number);
    if ((a.txIndex ?? 0) !== (b.txIndex ?? 0)) return (a.txIndex ?? 0) - (b.txIndex ?? 0);
    return (a.messageIndexWithinBatch ?? 0) - (b.messageIndexWithinBatch ?? 0);
  }
  if (aHas !== bHas) return aHas ? -1 : 1;
  // Neither has a coord — fall back to ingestSeq for stable order.
  return (a.ingestSeq ?? 0) - (b.ingestSeq ?? 0);
}

function restoreInto(live: State, snap: State): void {
  live.messages.clear();
  for (const [k, v] of snap.messages) live.messages.set(k, v);
  live.batches.clear();
  for (const [k, v] of snap.batches) live.batches.set(k, v);
  live.tagSeq.clear();
  for (const [k, v] of snap.tagSeq) live.tagSeq.set(k, v);
  live.nonces.clear();
  for (const [k, v] of snap.nonces) live.nonces.set(k, v);
  live.readerCursor.clear();
  for (const [k, v] of snap.readerCursor) live.readerCursor.set(k, v);
}
