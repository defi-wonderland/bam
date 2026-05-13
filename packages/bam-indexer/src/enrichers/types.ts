/**
 * Cross-cutting on-chain enrichment surface. Handlers declare what
 * they need (`IndexerHandler.enrichments`); the framework owns the
 * resolution, caching, and rate-limit posture so handlers don't
 * re-implement each enricher's discipline.
 */

import type { MessageRow } from 'bam-store';

import type {
  EnrichmentRequest,
  EnrichmentResult,
  IndexerHandler,
} from '../framework/handler.js';

export interface EnricherPool {
  resolve(
    handler: IndexerHandler<unknown>,
    row: MessageRow
  ): Promise<EnrichmentResult>;
}

export type EnrichmentKind = EnrichmentRequest['kind'];
