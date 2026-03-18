import { getLastConfirmedBlobble } from '@/db/queries';

export const COOLDOWN_MS = 60_000; // 1 minute

export async function getLastPostTime(): Promise<number | null> {
  const blobble = await getLastConfirmedBlobble();
  if (!blobble) return null;
  return new Date(blobble.created_at).getTime();
}
