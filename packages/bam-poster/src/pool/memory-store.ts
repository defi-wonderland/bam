import type { Address, Bytes32 } from 'bam-sdk';

import type {
  NonceTrackerRow,
  PendingKey,
  PosterStore,
  StoreTxn,
  StoreTxnPendingRow,
  StoreTxnSubmittedRow,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';

class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Composite key (sender, nonce) encoded as a single map key. */
function pendingKey(sender: Address, nonce: bigint): string {
  return `${sender.toLowerCase()}:${nonce.toString()}`;
}

interface PendingState {
  rows: Map<string, StoreTxnPendingRow>;
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
      const snapshot = {
        rows: new Map(this.pending.rows),
        tagSeq: new Map(this.pending.tagSeq),
        nonces: new Map(this.nonces),
        submitted: new Map(this.submitted),
      };
      const txn = this.makeTxn();
      try {
        return await fn(txn);
      } catch (err) {
        this.pending.rows.clear();
        for (const [k, v] of snapshot.rows) this.pending.rows.set(k, v);
        this.pending.tagSeq.clear();
        for (const [k, v] of snapshot.tagSeq) this.pending.tagSeq.set(k, v);
        this.nonces.clear();
        for (const [k, v] of snapshot.nonces) this.nonces.set(k, v);
        this.submitted.clear();
        for (const [k, v] of snapshot.submitted) this.submitted.set(k, v);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    // nothing to release
  }

  /** Test hook — unsafe outside tests. */
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
        const k = pendingKey(row.sender, row.nonce);
        if (pending.rows.has(k)) {
          throw new Error('insertPending: duplicate (sender, nonce)');
        }
        pending.rows.set(k, clonePending(row));
      },
      getPendingByKey(key: PendingKey): StoreTxnPendingRow | null {
        const row = pending.rows.get(pendingKey(key.sender, key.nonce));
        return row ? clonePending(row) : null;
      },
      listPendingByTag(tag: Bytes32, limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const all: StoreTxnPendingRow[] = [];
        for (const row of pending.rows.values()) {
          if (row.contentTag !== tag) continue;
          if (sinceSeq !== undefined && row.ingestSeq <= sinceSeq) continue;
          all.push(clonePending(row));
        }
        all.sort((a, b) => a.ingestSeq - b.ingestSeq);
        return typeof limit === 'number' ? all.slice(0, limit) : all;
      },
      listPendingAll(limit?: number, sinceSeq?: number): StoreTxnPendingRow[] {
        const all: StoreTxnPendingRow[] = [];
        for (const row of pending.rows.values()) {
          if (sinceSeq !== undefined && row.ingestSeq <= sinceSeq) continue;
          all.push(clonePending(row));
        }
        all.sort((a, b) => {
          if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt - b.ingestedAt;
          return a.ingestSeq - b.ingestSeq;
        });
        return typeof limit === 'number' ? all.slice(0, limit) : all;
      },
      deletePending(keys: PendingKey[]): void {
        for (const k of keys) pending.rows.delete(pendingKey(k.sender, k.nonce));
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

      getNonce(sender: Address): NonceTrackerRow | null {
        const row = nonces.get(sender.toLowerCase() as Address);
        return row ? { ...row } : null;
      },
      setNonce(row: NonceTrackerRow): void {
        const key = row.sender.toLowerCase() as Address;
        nonces.set(key, { ...row, sender: key });
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
          if (query.sinceBlock !== undefined) {
            if (row.blockNumber === null) continue;
            if (BigInt(row.blockNumber) < query.sinceBlock) continue;
          }
          results.push(cloneSubmitted(row));
        }
        results.sort((a, b) => b.submittedAt - a.submittedAt);
        return typeof query.limit === 'number' ? results.slice(0, query.limit) : results;
      },
      updateSubmittedStatus(
        txHash: Bytes32,
        status: SubmittedBatchStatus,
        replacedByTxHash: Bytes32 | null,
        blockNumber: number | null,
        invalidatedAt?: number | null
      ): void {
        const row = submitted.get(txHash);
        if (!row) throw new Error('updateSubmittedStatus: no row for tx_hash');
        submitted.set(txHash, {
          ...row,
          status,
          replacedByTxHash,
          blockNumber: blockNumber !== null ? blockNumber : row.blockNumber,
          invalidatedAt:
            invalidatedAt === undefined ? row.invalidatedAt : invalidatedAt,
        });
      },
    };
  }
}

export function createMemoryStore(): PosterStore {
  return new MemoryPosterStore();
}

function clonePending(row: StoreTxnPendingRow): StoreTxnPendingRow {
  return {
    ...row,
    contents: new Uint8Array(row.contents),
    signature: new Uint8Array(row.signature),
  };
}

function cloneSubmitted(row: StoreTxnSubmittedRow): StoreTxnSubmittedRow {
  return {
    ...row,
    messages: row.messages.map((m) => ({
      ...m,
      contents: new Uint8Array(m.contents),
      signature: new Uint8Array(m.signature),
    })),
  };
}
