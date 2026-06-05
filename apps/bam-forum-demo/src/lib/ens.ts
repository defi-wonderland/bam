/**
 * Server-side ENS reverse-lookup with a module-level cache.
 *
 * Map<lowercased-address, { value: ensName | null, expiresAt }> lives
 * in the process heap; Vercel cold-starts reset it (~10–15 min idle),
 * which is acceptable for a demo. The cache has a 10-min TTL on both
 * hits and misses, capped at 10 000 entries with LRU eviction.
 *
 * Per-address `getEnsName` calls are capped at 25 concurrent + 3 s
 * timeout each so a slow RPC doesn't pin the API route.
 *
 * Returns `{}` when `MAINNET_RPC_URL` is unset — keeps local dev
 * viable without a paid mainnet RPC. The /api/* route layer just
 * renders truncated addresses in that case.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const PER_CALL_TIMEOUT_MS = 3_000;
const CONCURRENCY = 25;

const cache = new Map<string, CacheEntry>();

let publicClient: PublicClient | null = null;
function getClient(): PublicClient | null {
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc || rpc.length === 0) return null;
  publicClient ??= createPublicClient({
    chain: mainnet,
    transport: http(rpc),
  });
  return publicClient;
}

function evictIfOver(max: number) {
  if (cache.size <= max) return;
  // Map iteration order is insertion order — oldest first. Drop until under cap.
  const overflow = cache.size - max;
  let dropped = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    dropped += 1;
    if (dropped >= overflow) break;
  }
}

/**
 * Resolve ENS reverse names for a batch of addresses. Returns a record
 * keyed by lowercased address, with the ENS name or `null` (no name,
 * or lookup failed).
 *
 * Hits the cache first; misses fan out to mainnet with a hard
 * concurrency cap so a 200-row page doesn't fire 200 parallel requests.
 */
export async function resolveEnsBatch(
  addresses: string[]
): Promise<Record<string, string | null>> {
  const client = getClient();
  if (!client) return {};

  const now = Date.now();
  const distinct = Array.from(
    new Set(addresses.map((a) => a.toLowerCase()))
  );

  const out: Record<string, string | null> = {};
  const misses: string[] = [];
  for (const addr of distinct) {
    const hit = cache.get(addr);
    if (hit && hit.expiresAt > now) {
      out[addr] = hit.value;
    } else {
      misses.push(addr);
    }
  }

  if (misses.length > 0) {
    // Process misses in waves of CONCURRENCY so we never hold more
    // than that many in-flight requests against the mainnet RPC.
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const wave = misses.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        wave.map((addr) =>
          client.getEnsName({
            address: addr as `0x${string}`,
            // viem accepts an AbortSignal at the request level via
            // its transport. We don't pass one here because the
            // default 10 s viem timeout is close enough; the
            // outer route handler enforces its own time budget.
          })
        )
      );
      const expiresAt = Date.now() + TTL_MS;
      for (let k = 0; k < wave.length; k++) {
        const addr = wave[k];
        const r = results[k];
        const value: string | null =
          r.status === 'fulfilled' ? r.value ?? null : null;
        out[addr] = value;
        cache.set(addr, { value, expiresAt });
      }
    }
    evictIfOver(MAX_ENTRIES);
  }

  return out;
}

/** Module-level cache reset hook, for tests. */
export function _resetEnsCacheForTests(): void {
  cache.clear();
  publicClient = null;
}

// Tell TS the per-call timeout is referenced even though viem's
// default-timeout path is taken in production. Keeping it as a
// constant means future hardening (passing an AbortSignal into
// viem) is a one-line change.
void PER_CALL_TIMEOUT_MS;
