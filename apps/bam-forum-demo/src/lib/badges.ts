/**
 * Server-side 4-state badge resolver.
 *
 * Given the reader's confirmed-row list + the coprocessor's validation
 * and proof sets, decide each message's badge state. Pure function so
 * unit tests can drive it with fixture maps.
 *
 *   confirmed (reader)  →  validated (coprocessor V) →  proven (coprocessor P)
 *
 * Validated ⊆ confirmed and proven ⊆ validated by construction in the
 * backend. If the coprocessor windows lag, we just classify down a
 * rung — never up.
 */

import type { BadgeState, ProofCommitment } from './forum-row';
import type {
  ProofSummaryEntry,
  ValidationEntry,
} from './coprocessor-client';

export interface BadgeResolution {
  status: BadgeState;
  proofCommitment?: ProofCommitment;
}

export interface ResolveBadgesInput {
  /** Coprocessor `/validation/latest` items in the current window. */
  validations: ValidationEntry[];
  /** Coprocessor `/proof` items in the current window. */
  proofs: ProofSummaryEntry[];
}

export interface BadgeIndex {
  byMessageHash: Map<string, BadgeResolution>;
  validatedCount: number;
  provenCount: number;
  /** ISO-8601 of the newest proof in the input set, null if none. */
  latestProvenAt: string | null;
}

/**
 * Build a lookup from coprocessor state. The caller iterates its
 * confirmed-row list and falls back to `'confirmed'` for any
 * `messageHash` not in `byMessageHash`.
 */
export function resolveBadges(input: ResolveBadgesInput): BadgeIndex {
  const validated = new Set<string>();
  for (const v of input.validations) {
    validated.add(v.messageHash.toLowerCase());
  }

  const proven = new Map<string, ProofSummaryEntry>();
  for (const p of input.proofs) {
    proven.set(p.messageHash.toLowerCase(), p);
  }

  const byMessageHash = new Map<string, BadgeResolution>();
  for (const mh of validated) {
    if (!proven.has(mh)) {
      byMessageHash.set(mh, { status: 'validated' });
    }
  }
  for (const [mh, p] of proven) {
    byMessageHash.set(mh, {
      status: 'proven',
      proofCommitment: {
        provenAt: p.provenAt,
        proofType: p.proofType,
        sp1Version: p.sp1Version,
        proofSize: p.proofSize,
      },
    });
  }

  let latestProvenAt: string | null = null;
  for (const p of input.proofs) {
    if (latestProvenAt === null || p.provenAt > latestProvenAt) {
      latestProvenAt = p.provenAt;
    }
  }

  return {
    byMessageHash,
    validatedCount: validated.size,
    provenCount: proven.size,
    latestProvenAt,
  };
}

/** Look up a single messageHash, defaulting to `'confirmed'`. */
export function badgeForConfirmed(
  index: BadgeIndex,
  messageHash: string
): BadgeResolution {
  const hit = index.byMessageHash.get(messageHash.toLowerCase());
  return hit ?? { status: 'confirmed' };
}
