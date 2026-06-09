/**
 * Fetches BlobBatchRegistered events for TWITTER_TAG from Sepolia,
 * then retrieves the blob bytes from Blobscan.
 *
 * Strategy: enumerate blob txs to BAMCore via Blobscan (avoids eth_getLogs
 * block-range limits), then fetch per-tx receipts to parse BBR / BSD events.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, stringToHex, decodeAbiParameters } from 'viem';
import { sepolia } from 'viem/chains';
import { hexToBytes, bytesToHex, FIELD_ELEMENTS_PER_BLOB } from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';
import { TWITTER_TAG } from './constants.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'batches.json');

const BAM_CORE = '0xAC01D2d2E8016a14eb2b4bd318ae221f866B9725' as const;
const BLOBSCAN_BASE = 'https://api.sepolia.blobscan.com';

// Keccak256 of the canonical event signatures — used to identify log topics.
const BBR_TOPIC = keccak256(
  stringToHex('BlobBatchRegistered(bytes32,address,bytes32,address,address)')
);
const BSD_TOPIC = keccak256(
  stringToHex('BlobSegmentDeclared(bytes32,address,uint16,uint16,bytes32)')
);

export interface BlobBatch {
  versionedHash: Bytes32;
  blockNumber: number;
  txIndex: number;
  logIndex: number;
  txHash: Bytes32;
  startFE: number;
  endFE: number;
  blobBytes: Uint8Array;
}

// ── Blobscan helpers ──────────────────────────────────────────────────────────

function extractHex(data: unknown): string | null {
  if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  for (const key of ['data', 'blobData']) {
    const v = o[key];
    if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return v;
  }
  const blob = o['blob'];
  if (blob && typeof blob === 'object') {
    for (const key of ['data', 'blobData']) {
      const v = (blob as Record<string, unknown>)[key];
      if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return v;
    }
  }
  return null;
}

function extractStorageUrls(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const refs = (data as Record<string, unknown>)['dataStorageReferences'];
  if (!Array.isArray(refs)) return [];
  return refs
    .filter((r): r is { url: string } => r && typeof r === 'object' && typeof r.url === 'string')
    .map((r) => r.url);
}

async function fetchBlobBytes(versionedHash: string): Promise<Uint8Array | null> {
  const res = await fetch(`${BLOBSCAN_BASE}/blobs/${versionedHash}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();

  const hex = extractHex(data);
  if (hex) return hexToBytes(hex);

  for (const url of extractStorageUrls(data)) {
    try {
      const bin = await fetch(url, { headers: { Accept: 'application/octet-stream' }, redirect: 'error' });
      if (!bin.ok) continue;
      return new Uint8Array(await bin.arrayBuffer());
    } catch {
      continue;
    }
  }
  return null;
}

// ── Blobscan tx enumeration ───────────────────────────────────────────────────

interface BlobscanTx {
  hash: string;
  blockNumber: number;
  index: number;
}

async function fetchAllBamTxs(onProgress?: (msg: string) => void): Promise<BlobscanTx[]> {
  const all: BlobscanTx[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${BLOBSCAN_BASE}/transactions?to=${BAM_CORE.toLowerCase()}&ps=100&p=${page}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) break;
    const data = (await res.json()) as { transactions?: BlobscanTx[] };
    const batch = data.transactions ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    page++;
  }
  onProgress?.(`  Found ${all.length} blob transactions to BAMCore via Blobscan`);
  return all;
}

// ── Parse BBR + BSD from a transaction receipt ────────────────────────────────

interface ParsedBbr {
  txHash: `0x${string}`;
  blockNumber: number;
  txIndex: number;
  logIndex: number;
  versionedHash: `0x${string}`;
}

interface ParsedBsd {
  logIndex: number;
  versionedHash: `0x${string}`;
  startFE: number;
  endFE: number;
}

function parseReceiptEvents(
  receipt: Awaited<ReturnType<ReturnType<typeof createPublicClient>['getTransactionReceipt']>>,
  blockNumber: number
): { bbr: ParsedBbr[]; bsd: ParsedBsd[] } {
  const bbr: ParsedBbr[] = [];
  const bsd: ParsedBsd[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BAM_CORE.toLowerCase()) continue;
    const t0 = log.topics[0];
    if (!t0) continue;

    // Filter: contentTag (topic[3]) must be TWITTER_TAG.
    const contentTag = log.topics[3];
    if (!contentTag || contentTag.toLowerCase() !== TWITTER_TAG.toLowerCase()) continue;

    if (t0 === BBR_TOPIC) {
      const versionedHash = log.topics[1];
      if (!versionedHash) continue;
      bbr.push({
        txHash: receipt.transactionHash,
        blockNumber,
        txIndex: receipt.transactionIndex,
        logIndex: log.logIndex,
        versionedHash: versionedHash as `0x${string}`,
      });
    } else if (t0 === BSD_TOPIC) {
      const versionedHash = log.topics[1];
      if (!versionedHash) continue;
      const [startFE, endFE] = decodeAbiParameters(
        [{ type: 'uint16' }, { type: 'uint16' }],
        log.data as `0x${string}`
      );
      bsd.push({
        logIndex: log.logIndex,
        versionedHash: versionedHash as `0x${string}`,
        startFE: Number(startFE),
        endFE: Number(endFE),
      });
    }
  }

  return { bbr, bsd };
}

// ── LIFO segment pairing (within one tx) ─────────────────────────────────────

function pairSegmentsForTx(
  bbrList: ParsedBbr[],
  bsdList: ParsedBsd[]
): Map<number, { startFE: number; endFE: number }> {
  if (bsdList.length === 0) return new Map();

  // Sort both by logIndex; BSDs always precede their paired BBR within a tx.
  const sortedBbr = [...bbrList].sort((a, b) => a.logIndex - b.logIndex);
  const pending = [...bsdList].sort((a, b) => a.logIndex - b.logIndex);

  const result = new Map<number, { startFE: number; endFE: number }>();

  for (const bbr of sortedBbr) {
    const originalIdx = bbrList.indexOf(bbr);
    // LIFO: find the last BSD with matching versionedHash that precedes this BBR.
    for (let j = pending.length - 1; j >= 0; j--) {
      const bsd = pending[j]!;
      if (
        bsd.logIndex < bbr.logIndex &&
        bsd.versionedHash.toLowerCase() === bbr.versionedHash.toLowerCase()
      ) {
        result.set(originalIdx, { startFE: bsd.startFE, endFE: bsd.endFE });
        pending.splice(j, 1);
        break;
      }
    }
  }

  return result;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

interface CachedBatch {
  versionedHash: string;
  blockNumber: number;
  txIndex: number;
  logIndex: number;
  txHash: string;
  startFE: number;
  endFE: number;
  blobBytesHex: string;
}

function loadCache(): BlobBatch[] | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CachedBatch[];
    return raw.map((b) => ({
      ...b,
      versionedHash: b.versionedHash as Bytes32,
      txHash: b.txHash as Bytes32,
      blobBytes: hexToBytes(b.blobBytesHex),
    }));
  } catch {
    return null;
  }
}

function saveCache(batches: BlobBatch[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const payload: CachedBatch[] = batches.map((b) => ({
    versionedHash: b.versionedHash,
    blockNumber: b.blockNumber,
    txIndex: b.txIndex,
    logIndex: b.logIndex,
    txHash: b.txHash,
    startFE: b.startFE,
    endFE: b.endFE,
    blobBytesHex: bytesToHex(b.blobBytes),
  }));
  writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function hasCachedBatches(): boolean {
  return existsSync(CACHE_FILE);
}

export async function fetchBlobBatches(
  rpcUrl: string | undefined,
  _fromBlock?: bigint,
  onProgress?: (msg: string) => void
): Promise<BlobBatch[]> {
  const cached = loadCache();
  if (cached) {
    onProgress?.(`  Loaded ${cached.length} blobs from cache (${CACHE_FILE})`);
    return cached;
  }

  if (!rpcUrl) throw new Error('RPC_URL required when no cache exists');

  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  // Step 1: get all blob tx hashes for BAMCore from Blobscan (no block-range limit).
  const blobscanTxs = await fetchAllBamTxs(onProgress);

  // Step 2: fetch receipt per tx; parse BBR + BSD events filtered by TWITTER_TAG.
  const allBbr: ParsedBbr[] = [];
  const txBsdMap = new Map<string, ParsedBsd[]>();

  await Promise.all(
    blobscanTxs.map(async (tx) => {
      const receipt = await client.getTransactionReceipt({
        hash: tx.hash as `0x${string}`,
      });
      const { bbr, bsd } = parseReceiptEvents(receipt, tx.blockNumber);
      for (const b of bbr) allBbr.push(b);
      if (bsd.length > 0) txBsdMap.set(tx.hash.toLowerCase(), bsd);
    })
  );

  onProgress?.(`  Found ${allBbr.length} TWITTER_TAG BlobBatchRegistered events`);

  // Sort BBRs into canonical chain order.
  allBbr.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
    return a.logIndex - b.logIndex;
  });

  // Step 3: pair BSD segments and fetch blob bytes.
  const batches: (BlobBatch | null)[] = await Promise.all(
    allBbr.map(async (bbr) => {
      const bsdList = txBsdMap.get(bbr.txHash.toLowerCase()) ?? [];
      const segMap = pairSegmentsForTx([bbr], bsdList);
      const range = segMap.get(0);

      onProgress?.(`  Fetching blob ${bbr.versionedHash.slice(0, 10)}…`);
      const blobBytes = await fetchBlobBytes(bbr.versionedHash);
      if (!blobBytes) {
        onProgress?.(`  ⚠ Blobscan has no data for ${bbr.versionedHash.slice(0, 10)} — skipping`);
        return null;
      }

      return {
        versionedHash: bbr.versionedHash as Bytes32,
        blockNumber: bbr.blockNumber,
        txIndex: bbr.txIndex,
        logIndex: bbr.logIndex,
        txHash: bbr.txHash as Bytes32,
        startFE: range?.startFE ?? 0,
        endFE: range?.endFE ?? FIELD_ELEMENTS_PER_BLOB,
        blobBytes,
      };
    })
  );

  const result = batches.filter((b): b is BlobBatch => b !== null);
  saveCache(result);
  onProgress?.(`  Saved to cache (${CACHE_FILE})`);
  return result;
}
