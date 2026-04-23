import type { Address, Bytes32 } from 'bam-sdk';

import type {
  NonceTrackerRow,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';

/**
 * Process-local async mutex: serializes `withTxn` callers so the
 * in-memory store has the same linearizable semantics the DB adapters
 * get from `BEGIN IMMEDIATE` / SERIALIZABLE.
 */
class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    // Swallow rejections in the chain so a failed txn doesn't poison
    // subsequent acquirers.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

interface PendingState {
  rows: Map<Bytes32, StoreTxnPendingRow>;
  /** Per-tag FIFO counter. Assigned as `ingest_seq`. */
  tagSeq: Map<Bytes32, number>;
}

export class MemoryPosterStore implements PosterStore {
  private readonly lock = new AsyncLock();
  private readonly pending: PendingState = {
    rows: new Map(),
    tagSeq: new Map(),
  };
  private readonly nonces = new Map<Address, NonceTrackerRow>();
  private readonly submitted = new Map<Bytes32, StoreTxnSubmittedRow>();

  async withTxn<T>(fn: (txn: StoreTxn) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const txn = this.makeTxn();
      return fn(txn);
    });
  }

  async close(): Promise<void> {
    // nothing to release
  }

  // Test hook — unsafe outside tests.
  _unsafeClear(): void {
    this.pending.rows.clear();
    this.pending.tagSeq.clear();
    this.nonces.clear();
    this.submitted.clear();
  }

  private makeTxn(): StoreTxn {
    const pending = this.pending;
    const nonces = this.nonces;
    const submitted = this.submitted;

    return {
      insertPending(row: StoreTxnPendingRow): void {
        if (pending.rows.has(row.messageId)) {
          throw new Error('insertPending: duplicate message_id');
        }
        pending.rows.set(row.messageId, { ...row });
      },
      getPendingByMessageId(messageId: Bytes32): StoreTxnPendingRow | null {
        const row = pending.rows.get(messageId);
        return row ? { ...row } : null;
      },
      listPendingByTag(tag: Bytes32, limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const all: StoreTxnPendingRow[] = [];
        for (const row of pending.rows.values()) {
          if (row.contentTag !== tag) continue;
          if (sinceSeq !== undefined && row.ingestSeq <= sinceSeq) continue;
          all.push({ ...row });
        }
        all.sort((a, b) => a.ingestSeq - b.ingestSeq);
        return typeof limit === 'number' ? all.slice(0, limit) : all;
      },
      listPendingAll(limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const all: StoreTxnPendingRow[] = [];
        for (const row of pending.rows.values()) {
          if (sinceSeq !== undefined && row.ingestSeq <= sinceSeq) continue;
          all.push({ ...row });
        }
        all.sort((a, b) => {
          if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt - b.ingestedAt;
          return a.ingestSeq - b.ingestSeq;
        });
        return typeof limit === 'number' ? all.slice(0, limit) : all;
      },
      deletePending(messageIds: Bytes32[]): void {
        for (const id of messageIds) pending.rows.delete(id);
      },
      countPendingByTag(tag: Bytes32): number {
        let count = 0;
        for (const row of pending.rows.values()) {
          if (row.contentTag === tag) count++;
        }
        return count;
      },
      nextIngestSeq(tag: Bytes32): number {
        const cur = pending.tagSeq.get(tag) ?? 0;
        const next = cur + 1;
        pending.tagSeq.set(tag, next);
        return next;
      },

      getNonce(author: Address): NonceTrackerRow | null {
        // FU-6: match SqlitePosterStore's behavior — address key is
        // always lowercased. Without this, an in-memory-backed
        // Poster would treat mixed-case callers as distinct authors,
        // which the sqlite adapter merges.
        const row = nonces.get(author.toLowerCase() as Address);
        return row ? { ...row } : null;
      },
      setNonce(row: NonceTrackerRow): void {
        const key = row.author.toLowerCase() as Address;
        nonces.set(key, { ...row, author: key });
      },

      insertSubmitted(row: StoreTxnSubmittedRow): void {
        if (submitted.has(row.txHash)) {
          throw new Error('insertSubmitted: duplicate tx_hash');
        }
        submitted.set(row.txHash, cloneSubmitted(row));
      },
      getSubmittedByTx(txHash: Bytes32): StoreTxnSubmittedRow | null {
        const row = submitted.get(txHash);
        return row ? cloneSubmitted(row) : null;
      },
      listSubmitted(query: SubmittedBatchesQuery): StoreTxnSubmittedRow[] {
        const results: StoreTxnSubmittedRow[] = [];
        for (const row of submitted.values()) {
          if (query.contentTag !== undefined && row.contentTag !== query.contentTag) continue;
          if (
            query.sinceBlock !== undefined &&
            row.blockNumber !== null &&
            BigInt(row.blockNumber) < query.sinceBlock
          )
            continue;
          results.push(cloneSubmitted(row));
        }
        // Newest first by submittedAt.
        results.sort((a, b) => b.submittedAt - a.submittedAt);
        return typeof query.limit === 'number' ? results.slice(0, query.limit) : results;
      },
      updateSubmittedStatus(
        txHash: Bytes32,
        status: SubmittedBatchStatus,
        replacedByTxHash: Bytes32 | null,
        blockNumber: number | null
      ): void {
        const row = submitted.get(txHash);
        if (!row) throw new Error('updateSubmittedStatus: no row for tx_hash');
        row.status = status;
        row.replacedByTxHash = replacedByTxHash;
        if (blockNumber !== null) row.blockNumber = blockNumber;
      },
    };
  }
}

export function createMemoryStore(): PosterStore {
  return new MemoryPosterStore();
}

function cloneSubmitted(row: StoreTxnSubmittedRow): StoreTxnSubmittedRow {
  return {
    ...row,
    messageIds: [...row.messageIds],
    messages: row.messages.map((m) => ({
      ...m,
      signature: new Uint8Array(m.signature),
    })),
  };
}
