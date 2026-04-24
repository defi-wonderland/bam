import type { Address, Bytes32 } from 'bam-sdk';

import type { BamStore, Signer, Status } from '../types.js';

export interface StatusRpcReader {
  getBalance(address: Address): Promise<bigint>;
}

export interface StatusOptions {
  store: BamStore;
  rpc: StatusRpcReader;
  signer: Signer;
  configuredTags: readonly Bytes32[];
  /** Chain id this Poster is configured for. Filters listBatches so a
   * shared DB doesn't surface another chain's batches. */
  chainId: number;
}

/**
 * `status()` read surface — quantitative. Disjoint from `health()`:
 * this surface returns numbers and refs to last-submitted batches; it
 * never returns `state` / `reason`.
 *
 * `lastSubmittedByTag` only includes batches this Poster wrote — those
 * are the ones with a non-null `submittedAt`. A batch without a
 * `submittedAt` came from somewhere else (e.g. a shared-DB Reader
 * observing the chain) and is not ours to surface as "we last
 * submitted at X."
 */
export async function readStatus(opts: StatusOptions): Promise<Status> {
  const walletAddress = opts.signer.account().address;
  const walletBalanceWei = await opts.rpc.getBalance(walletAddress);

  const pendingByTag: Status['pendingByTag'] = [];
  const lastSubmittedByTag: Status['lastSubmittedByTag'] = [];

  await opts.store.withTxn(async (txn) => {
    for (const tag of opts.configuredTags) {
      const count = await txn.countPendingByTag(tag);
      pendingByTag.push({ contentTag: tag, count });
      // Pull a few candidates and pick the most-recently submitted whose
      // `submittedAt` is non-null; the store orders by submitted_at DESC,
      // so any null-submittedAt rows already sort to the end (and are
      // filtered defensively here).
      const recent = await txn.listBatches({
        chainId: opts.chainId,
        contentTag: tag,
        limit: 8,
      });
      const last = recent.find((b) => b.submittedAt !== null);
      if (last !== undefined && last.submittedAt !== null) {
        lastSubmittedByTag.push({
          contentTag: tag,
          txHash: last.txHash,
          blobVersionedHash: last.blobVersionedHash,
          blockNumber: last.blockNumber,
          submittedAt: last.submittedAt,
        });
      }
    }
  });

  return {
    walletAddress,
    walletBalanceWei,
    configuredTags: [...opts.configuredTags],
    pendingByTag,
    lastSubmittedByTag,
  };
}
