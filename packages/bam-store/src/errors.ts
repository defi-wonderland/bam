/**
 * Typed errors thrown by the store adapter. Kept narrow so callers
 * (the Poster ingest path in particular) can pattern-match on the
 * class instead of sniffing message strings.
 */

import type { Address } from 'bam-sdk';

/**
 * Thrown by `insertPending` when the target `(sender, nonce)` already
 * holds a non-`reorged` row.
 *
 * Distinguishes "tried to write to a slot that is already taken" from
 * arbitrary DB faults, so the Poster's ingest path can map this to a
 * stable `duplicate` rejection instead of letting it surface as a 500
 * `internal_error`.
 *
 * The scenario that motivated the type: a Reader-populated database
 * with an empty Poster `nonces` tracker — the monotonicity check
 * green-lights `nonce = 0` for a sender whose confirmed history on
 * chain already covers that slot, and the insert collides.
 */
export class DuplicateMessageError extends Error {
  readonly name = 'DuplicateMessageError';
  readonly sender: Address;
  readonly nonce: bigint;
  constructor(sender: Address, nonce: bigint) {
    super(`insertPending: duplicate (sender, nonce)=(${sender}, ${nonce})`);
    this.sender = sender;
    this.nonce = nonce;
  }
}
