/**
 * ENS reverse-resolver enricher. Calls `publicClient.getEnsName` and
 * caches by sender address. Misses (no primary name set) are
 * negative-cached for `NEGATIVE_TTL_MS` so the indexer doesn't spam
 * the RPC for the common case of an EOA without ENS.
 *
 * Names are resolved at indexer-head, not at the message's inclusion
 * block. A renamed ENS will eventually flip on the next cache miss.
 * Accept the divergence for v1; stake (when wired) MUST resolve at
 * block to stay reproducible across indexers.
 */

import type { PublicClient } from 'viem';
import type { Address } from 'bam-sdk';

const DEFAULT_HIT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MISS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

export interface EnsEnricherOptions {
  client: PublicClient;
  hitTtlMs?: number;
  missTtlMs?: number;
  maxEntries?: number;
}

export class EnsEnricher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly client: PublicClient;
  private readonly hitTtl: number;
  private readonly missTtl: number;
  private readonly maxEntries: number;

  constructor(opts: EnsEnricherOptions) {
    this.client = opts.client;
    this.hitTtl = opts.hitTtlMs ?? DEFAULT_HIT_TTL_MS;
    this.missTtl = opts.missTtlMs ?? DEFAULT_MISS_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async resolve(address: Address): Promise<string | null> {
    const key = address.toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      // Refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.value;
    }
    let value: string | null = null;
    try {
      value = await this.client.getEnsName({ address: address as `0x${string}` });
    } catch {
      // Treat RPC failures as misses; the negative cache prevents
      // a thundering herd while keeping the indexer moving. A
      // healthier RPC will refill on the next miss-TTL expiry.
      value = null;
    }
    this.put(key, value, now);
    return value;
  }

  private put(key: string, value: string | null, now: number): void {
    if (this.cache.size >= this.maxEntries) {
      // LRU eviction: drop the oldest insertion (Map iteration is in
      // insertion order; we move-to-front on reads above).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const ttl = value === null ? this.missTtl : this.hitTtl;
    this.cache.set(key, { value, expiresAt: now + ttl });
  }
}
