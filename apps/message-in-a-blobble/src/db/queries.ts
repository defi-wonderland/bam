import type { DbMessage, DbBlobble } from './types';
export type { DbMessage, DbBlobble } from './types';

const usePostgres = !!process.env.POSTGRES_URL;

async function getImpl() {
  if (usePostgres) {
    return await import('./postgres');
  }
  return await import('./sqlite');
}

export async function insertMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  signature: string;
}): Promise<DbMessage> {
  const impl = await getImpl();
  return impl.insertMessage(msg);
}

export async function getMessages(status?: string): Promise<DbMessage[]> {
  const impl = await getImpl();
  return impl.getMessages(status);
}

export async function getPendingMessages(): Promise<DbMessage[]> {
  const impl = await getImpl();
  return impl.getPendingMessages();
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

export async function markMessagesPosted(messageIds: string[], blobbleId: string): Promise<void> {
  const impl = await getImpl();
  return impl.markMessagesPosted(messageIds, blobbleId);
}
