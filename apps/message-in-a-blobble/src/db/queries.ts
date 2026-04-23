import type { DbMessage, DbBlobble } from './types';
export type { DbMessage, DbBlobble } from './types';

// Pending-pool state (inserts / pending reads / post-blobble markers)
// now lives in the `@bam/poster` service; these exports were removed
// during the poster migration. The sync indexer's confirmed-write path
// is retained below.

const usePostgres = !!process.env.POSTGRES_URL;

async function getImpl() {
  if (usePostgres) {
    return await import('./postgres');
  }
  return await import('./sqlite');
}

export async function getMessages(status?: string): Promise<DbMessage[]> {
  const impl = await getImpl();
  return impl.getMessages(status);
}

export async function createBlobble(id: string, messageCount: number): Promise<DbBlobble> {
  const impl = await getImpl();
  return impl.createBlobble(id, messageCount);
}

export async function updateBlobbleStatus(
  id: string,
  status: 'pending' | 'confirmed' | 'failed',
  txHash?: string,
  blockNumber?: number
): Promise<void> {
  const impl = await getImpl();
  return impl.updateBlobbleStatus(id, status, txHash, blockNumber);
}

export async function getSyncedBlobbleTxHashes(): Promise<string[]> {
  const impl = await getImpl();
  return impl.getSyncedBlobbleTxHashes();
}

export async function insertSyncedMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  blobble_id: string;
}): Promise<void> {
  const impl = await getImpl();
  return impl.insertSyncedMessage(msg);
}
