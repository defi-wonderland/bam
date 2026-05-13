/**
 * Per-tick enrichment dispatcher. Walks `handler.enrichments` and
 * fans out to the configured enrichers, returning a single typed
 * `EnrichmentResult`. v1 supports only `ens`; the other kinds are
 * declared in the handler interface so handlers can stake out their
 * needs ahead of `StakeManager` / `ECDSARegistry` wiring without
 * each one redoing the call surface.
 */

import type { Address } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import type {
  EnrichmentRequest,
  EnrichmentResult,
  IndexerHandler,
} from '../framework/handler.js';
import type { EnricherPool } from './types.js';
import type { EnsEnricher } from './ens.js';

export interface BatchEnricherOptions {
  ens?: EnsEnricher;
}

export class BatchEnricherPool implements EnricherPool {
  private readonly ens: EnsEnricher | undefined;
  constructor(opts: BatchEnricherOptions) {
    this.ens = opts.ens;
  }

  async resolve(
    handler: IndexerHandler<unknown>,
    row: MessageRow
  ): Promise<EnrichmentResult> {
    const out: EnrichmentResult = {};
    const requests = handler.enrichments ?? [];
    await Promise.all(
      requests.map((req) => this.resolveOne(req, row, out))
    );
    return out;
  }

  private async resolveOne(
    req: EnrichmentRequest,
    row: MessageRow,
    out: EnrichmentResult
  ): Promise<void> {
    const target: Address =
      req.from === 'sender'
        ? row.sender
        : // `submitter` lives on `BatchRow`, not `MessageRow`. v1 has
          // no handler asking for it, so we fall back to `sender` and
          // log nothing. When a handler genuinely needs the batch
          // submitter, the source contract will widen `listConfirmedAfter`
          // to JOIN `batches`; we don't pay that cost speculatively.
          row.sender;
    switch (req.kind) {
      case 'ens': {
        if (this.ens === undefined) {
          out.ens = null;
          return;
        }
        out.ens = await this.ens.resolve(target);
        return;
      }
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
