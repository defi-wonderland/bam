import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type FeeHistoryResult = {
  baseFeePerGas?: string[];
  baseFeePerBlobGas?: string[];
  oldestBlock?: string;
};

type PriceCache = { value: number; fetchedAt: number };
const PRICE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
let priceCache: PriceCache | null = null;

export async function GET() {
  const rpc = process.env.RPC_URL || 'https://ethereum-rpc.publicnode.com';
  const blocks = Math.max(1, Math.min(1024, Number(process.env.FEE_HISTORY_BLOCKS) || 20));
  const blocksHex = `0x${blocks.toString(16)}`;

  const [feeResult, ethUsd] = await Promise.all([
    fetchFeeHistory(rpc, blocksHex),
    fetchEthUsd(),
  ]);

  if ('error' in feeResult) {
    return NextResponse.json({ error: feeResult.error }, { status: 502 });
  }

  // eth_feeHistory returns `baseFeePerGas` with blockCount + 1 entries: the
  // final element is the *next* block's predicted base fee, not historical.
  // Trim it off before averaging so the historical window matches the request.
  const baseFees = trimNextBlock(feeResult.result.baseFeePerGas);
  const blobFees = trimNextBlock(feeResult.result.baseFeePerBlobGas);

  // Fail loud rather than silently returning "0 gwei" if the RPC's response
  // is missing either array — otherwise the UI would display free costs.
  if (baseFees.length === 0 || blobFees.length === 0) {
    const missing = [
      baseFees.length === 0 ? 'baseFeePerGas' : null,
      blobFees.length === 0 ? 'baseFeePerBlobGas' : null,
    ]
      .filter(Boolean)
      .join(', ');
    return NextResponse.json(
      { error: `RPC eth_feeHistory missing ${missing}` },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      latestBaseFeeWei: latest(baseFees).toString(),
      latestBlobBaseFeeWei: latest(blobFees).toString(),
      avgBaseFeeWei: avg(baseFees).toString(),
      avgBlobBaseFeeWei: avg(blobFees).toString(),
      blocks: Math.max(baseFees.length, blobFees.length),
      ethUsd: ethUsd.value,
      ethUsdSource: ethUsd.source,
      ethUsdFetchedAt: ethUsd.fetchedAt,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function fetchFeeHistory(
  rpc: string,
  blocksHex: string,
): Promise<{ result: FeeHistoryResult } | { error: string }> {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_feeHistory',
        params: [blocksHex, 'latest', []],
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `RPC HTTP ${res.status}` };
    const json = (await res.json()) as { result?: FeeHistoryResult; error?: { message?: string } };
    if (!json.result) return { error: json.error?.message ?? 'RPC returned no result' };
    return { result: json.result };
  } catch (e) {
    return { error: `RPC unreachable: ${(e as Error).message}` };
  }
}

async function fetchEthUsd(): Promise<{ value: number | null; source: string; fetchedAt: string | null }> {
  const now = Date.now();
  if (priceCache && now - priceCache.fetchedAt < PRICE_TTL_MS) {
    return {
      value: priceCache.value,
      source: 'coingecko (cached)',
      fetchedAt: new Date(priceCache.fetchedAt).toISOString(),
    };
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { ethereum?: { usd?: number } };
    const usd = json.ethereum?.usd;
    if (typeof usd !== 'number') throw new Error('missing field ethereum.usd');
    priceCache = { value: usd, fetchedAt: now };
    return { value: usd, source: 'coingecko', fetchedAt: new Date(now).toISOString() };
  } catch (e) {
    // Fall back to the stale cache if present, otherwise null.
    if (priceCache) {
      return {
        value: priceCache.value,
        source: `coingecko (stale, ${(e as Error).message})`,
        fetchedAt: new Date(priceCache.fetchedAt).toISOString(),
      };
    }
    return { value: null, source: `coingecko (failed: ${(e as Error).message})`, fetchedAt: null };
  }
}

function trimNextBlock(hex: string[] | undefined): bigint[] {
  if (!hex || hex.length === 0) return [];
  // Drop the trailing predicted-next-block entry; keep at least one when only
  // the prediction is present (so the route still returns something usable).
  const historical = hex.length > 1 ? hex.slice(0, -1) : hex;
  return historical.map((h) => BigInt(h));
}

function latest(arr: bigint[]): bigint {
  return arr.length > 0 ? arr[arr.length - 1] : 0n;
}

function avg(arr: bigint[]): bigint {
  if (arr.length === 0) return 0n;
  let sum = 0n;
  for (const v of arr) sum += v;
  return sum / BigInt(arr.length);
}
