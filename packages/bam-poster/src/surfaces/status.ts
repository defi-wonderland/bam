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
}

/**
 * `status()` read surface — quantitative. Disjoint from `health()`:
 * this surface returns numbers and refs to last-submitted batches; it
 * never returns `state` / `reason`.
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
      const recent = await txn.listBatches({ contentTag: tag, limit: 1 });
      const last = recent[0];
      if (last !== undefined) {
        lastSubmittedByTag.push({
          contentTag: tag,
          txHash: last.txHash,
          blobVersionedHash: last.blobVersionedHash,
          blockNumber: last.blockNumber,
          submittedAt: last.submittedAt ?? 0,
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
