/**
 * Server-side dashboard data assembly. Extracted from `page.tsx` so
 * the integration test (T012) can exercise the same per-panel
 * isolation contract the page renders, without going through React's
 * server-component pipeline.
 */

import type { Bytes32 } from 'bam-sdk';

import { readContentTags, readPanelLimit } from './config';
import {
  fetchPosterHealth,
  fetchPosterPending,
  fetchPosterStatus,
  fetchPosterSubmittedBatches,
  fetchReaderBatches,
  fetchReaderHealth,
  fetchReaderMessages,
} from './fetchers';
import type { PanelResult } from './panel-result';

export interface DashboardData {
  fetchedAt: number;
  contentTags: Bytes32[];
  noTagsConfigured: boolean;
  posterHealth: PanelResult<unknown>;
  posterStatus: PanelResult<unknown>;
  posterPending: PanelResult<unknown>;
  posterSubmittedBatches: PanelResult<unknown>;
  readerHealth: PanelResult<unknown>;
  readerBatchesByTag: Map<Bytes32, PanelResult<unknown>>;
  readerMessagesByTag: Map<Bytes32, PanelResult<unknown>>;
}

export async function assembleDashboardData(): Promise<DashboardData> {
  const fetchedAt = Date.now();
  const contentTags = readContentTags();
  const noTagsConfigured = contentTags.length === 0;

  const pendingLimit = readPanelLimit('pending');
  const submittedLimit = readPanelLimit('submitted');
  const batchesLimit = readPanelLimit('batches');
  const messagesLimit = readPanelLimit('messages');

  const [
    posterHealth,
    posterStatus,
    posterPending,
    posterSubmittedBatches,
    readerHealth,
    readerBatchesEntries,
    readerMessagesEntries,
  ] = await Promise.all([
    fetchPosterHealth(),
    fetchPosterStatus(),
    fetchPosterPending(pendingLimit),
    fetchPosterSubmittedBatches(submittedLimit),
    fetchReaderHealth(),
    Promise.all(
      contentTags.map(async (tag) => [tag, await fetchReaderBatches(tag, batchesLimit)] as const)
    ),
    Promise.all(
      contentTags.map(async (tag) => [tag, await fetchReaderMessages(tag, messagesLimit)] as const)
    ),
  ]);

  return {
    fetchedAt,
    contentTags,
    noTagsConfigured,
    posterHealth,
    posterStatus,
    posterPending,
    posterSubmittedBatches,
    readerHealth,
    readerBatchesByTag: new Map(readerBatchesEntries),
    readerMessagesByTag: new Map(readerMessagesEntries),
  };
}
