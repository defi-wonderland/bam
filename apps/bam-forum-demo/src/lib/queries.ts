/**
 * React-query hooks for the forum feeds. All three keys live under the
 * `forum` prefix so a single `invalidateQueries({ queryKey: ['forum'] })`
 * call after a submit refreshes both feeds at once.
 */

'use client';

import { useQuery } from '@tanstack/react-query';

import type {
  ForumMessage,
  ProofCounts,
} from './forum-row';

export interface ConfirmedResponse {
  messages: ForumMessage[];
  proofCounts: ProofCounts;
}

export interface PendingResponse {
  messages: ForumMessage[];
}

export interface ProofBundle {
  messageHash: string;
  chainId: number;
  versionedHash: string;
  contentTag: string;
  startFe: number;
  endFe: number;
  blockNumber: number;
  txIndex: number;
  msgIndex: number;
  sender: string;
  nonce: string;
  cycles: number;
  proofSize: number;
  proofType: string;
  requestId: string;
  txHash: string | null;
  sp1Version: string;
  provenAt: string;
  proofBytes: string;
  publicValues: string;
  vkUrl: string;
}

const CONFIRMED_REFETCH_MS = 15_000;
const PENDING_REFETCH_MS = 5_000;

export const CONFIRMED_KEY = ['forum', 'confirmed'] as const;
export function pendingKey(sender: string | null | undefined): readonly unknown[] {
  return ['forum', 'pending', sender ?? null] as const;
}
export function proofKey(messageHash: string | null): readonly unknown[] {
  return ['forum', 'proof', messageHash] as const;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export function useConfirmed() {
  return useQuery({
    queryKey: CONFIRMED_KEY,
    queryFn: () => fetchJson<ConfirmedResponse>('/api/confirmed'),
    refetchInterval: CONFIRMED_REFETCH_MS,
    staleTime: CONFIRMED_REFETCH_MS,
  });
}

export function usePending(sender: string | null | undefined) {
  return useQuery({
    queryKey: pendingKey(sender),
    queryFn: () =>
      sender
        ? fetchJson<PendingResponse>(`/api/pending?sender=${encodeURIComponent(sender)}`)
        : Promise.resolve<PendingResponse>({ messages: [] }),
    enabled: !!sender,
    refetchInterval: PENDING_REFETCH_MS,
    staleTime: PENDING_REFETCH_MS,
  });
}

export function useProof(messageHash: string | null) {
  return useQuery({
    queryKey: proofKey(messageHash),
    queryFn: () =>
      messageHash
        ? fetchJson<ProofBundle>(`/api/proof/${encodeURIComponent(messageHash)}`)
        : Promise.resolve<ProofBundle | null>(null),
    enabled: !!messageHash,
    staleTime: Infinity,
  });
}
