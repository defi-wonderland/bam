import { createPublicClient, http, commitmentsToVersionedHashes } from 'viem';
import { sepolia } from 'viem/chains';

/**
 * Fetch blob data for a transaction, trying Beacon API first, then Blobscan.
 * Returns the raw blob bytes or null if unavailable.
 */
export async function fetchBlobForTx(txHash: string): Promise<Uint8Array | null> {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  if (!receipt) return null;

  const tx = await publicClient.getTransaction({
    hash: txHash as `0x${string}`,
  });

  const blobVersionedHashes = tx.blobVersionedHashes;
  if (!blobVersionedHashes || blobVersionedHashes.length === 0) return null;

  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const parentBeaconBlockRoot =
    block && 'parentBeaconBlockRoot' in block
      ? (block as { parentBeaconBlockRoot?: string }).parentBeaconBlockRoot ?? null
      : null;

  return (
    (await fetchFromBeaconApi(parentBeaconBlockRoot, blobVersionedHashes[0])) ??
    (await fetchFromBlobscan(blobVersionedHashes[0]))
  );
}

/**
 * Extract usable bytes from a raw blob (skip byte 0 of each 32-byte field element)
 */
export function extractUsableBytes(blob: Uint8Array): Uint8Array {
  const FIELD_ELEMENTS = 4096;
  const BYTES_PER_FE = 32;
  const USABLE_PER_FE = 31;
  const result = new Uint8Array(FIELD_ELEMENTS * USABLE_PER_FE);

  for (let fe = 0; fe < FIELD_ELEMENTS; fe++) {
    const src = fe * BYTES_PER_FE + 1;
    const dst = fe * USABLE_PER_FE;
    result.set(blob.slice(src, src + USABLE_PER_FE), dst);
  }

  return result;
}

async function findSlotFromParentBeaconRoot(
  beaconUrl: string,
  parentBeaconBlockRoot: string
): Promise<string | null> {
  const base = beaconUrl.replace(/\/$/, '');
  const root = parentBeaconBlockRoot.startsWith('0x')
    ? parentBeaconBlockRoot
    : `0x${parentBeaconBlockRoot}`;
  const res = await fetch(
    `${base}/eth/v1/beacon/headers?parent_root=${encodeURIComponent(root)}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const headers = data?.data;
  if (!Array.isArray(headers) || headers.length === 0) return null;
  const slot =
    headers[0]?.header?.message?.slot ?? headers[0]?.message?.slot ?? headers[0]?.slot;
  if (slot === undefined) return null;
  return String(slot);
}

async function fetchFromBeaconApi(
  parentBeaconBlockRoot: string | null,
  targetVersionedHash: string
): Promise<Uint8Array | null> {
  const beaconUrl = process.env.BEACON_API_URL;
  if (!beaconUrl || !parentBeaconBlockRoot) return null;

  try {
    const slot = await findSlotFromParentBeaconRoot(beaconUrl, parentBeaconBlockRoot);
    if (!slot) return null;

    const base = beaconUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/eth/v1/beacon/blob_sidecars/${slot}`);
    if (!res.ok) return null;

    const json = await res.json();
    const sidecars: Array<{ kzg_commitment?: string; blob?: string }> = json.data || [];
    if (sidecars.length === 0) return null;

    const targetHashNorm = targetVersionedHash.toLowerCase();
    for (const sc of sidecars) {
      const commitment = sc.kzg_commitment;
      if (!commitment?.startsWith('0x')) continue;
      const hashes = commitmentsToVersionedHashes({
        commitments: [commitment as `0x${string}`],
      });
      const vh = (typeof hashes[0] === 'string' ? hashes[0] : '') as string;
      if (vh.toLowerCase() === targetHashNorm && sc.blob) {
        return hexToUint8Array(sc.blob);
      }
    }
    if (sidecars.length === 1 && sidecars[0].blob) {
      return hexToUint8Array(sidecars[0].blob);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFromBlobscan(targetVersionedHash: string): Promise<Uint8Array | null> {
  try {
    const url = `https://api.sepolia.blobscan.com/blobs/${targetVersionedHash}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      dataStorageReferences?: Array<{ storage?: string; url?: string }>;
      data?: string;
      blob?: string | { data?: string };
      blobData?: string;
    };

    const hex = extractBlobHex(data);
    if (hex) return hexToUint8Array(hex);

    const ref = data.dataStorageReferences?.[0];
    const blobUrl = ref?.url;
    if (blobUrl) {
      const blobRes = await fetch(blobUrl);
      if (!blobRes.ok) return null;
      const buf = await blobRes.arrayBuffer();
      return new Uint8Array(buf);
    }

    return null;
  } catch {
    return null;
  }
}

function extractBlobHex(data: unknown): string | null {
  if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const candidates = [
    o.data,
    o.blob,
    o.blobData,
    (o.blob as Record<string, unknown>)?.data,
    (o.blob as Record<string, unknown>)?.blobData,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return raw;
    if (raw && typeof raw === 'object' && typeof (raw as { hex?: string }).hex === 'string')
      return (raw as { hex: string }).hex;
    if (raw && typeof raw === 'object' && typeof (raw as { data?: string }).data === 'string')
      return (raw as { data: string }).data;
  }
  return null;
}

function hexToUint8Array(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
