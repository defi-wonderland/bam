/**
 * Per-tick enrichment dispatcher. Walks `handler.enrichments` and
 * fans out to the configured enrichers, returning a single typed
 * `EnrichmentResult`. No enrichers are wired today; the kinds in
 * `EnrichmentRequest` (`stake`, `ecdsa-registry`, `allowlist`) are
 * placeholders for `StakeManager` / `ECDSARegistry` integration and
 * currently resolve to `null`. ENS resolution lives client-side.
 */

import type { MessageRow } from 'bam-store';

import type {
  EnrichmentRequest,
  EnrichmentResult,
  IndexerHandler,
} from '../framework/handler.js';
import type { EnricherPool } from './types.js';

export class BatchEnricherPool implements EnricherPool {
  async resolve(
    handler: IndexerHandler<unknown>,
    _row: MessageRow,
  ): Promise<EnrichmentResult> {
    const out: EnrichmentResult = {};
    for (const req of handler.enrichments ?? []) {
      this.resolveOne(req, out);
    }
    return out;
  }

  private resolveOne(req: EnrichmentRequest, out: EnrichmentResult): void {
    switch (req.kind) {
      case 'stake':
        out.stake = null;
        return;
      case 'ecdsa-registry':
        out.ecdsaRegistered = null;
        return;
      case 'allowlist':
        out.allowlisted = null;
        return;
    }
  }
}
