import type { Address, Bytes32 } from 'bam-sdk';

import type { StoreTxn } from '../types.js';
import type { PosterRejection } from '../errors.js';

export type MonotonicityOutcome =
  | { decision: 'accept' }
  | { decision: 'no_op'; existingMessageHash: Bytes32 }
  | { decision: 'reject'; reason: PosterRejection };

/**
 * ERC-8180 §Nonce Semantics enforcement, scoped per sender across all
 * content tags the Poster serves (the ERC's signing domain binds
 * `(sender, nonce, contents)` with no tag).
 *
 * Behavior on an ingest with `(sender, nonce, messageHash)`:
 *   - No last-accepted record              → accept.
 *   - `nonce > last_nonce`                  → accept.
 *   - `nonce == last_nonce` AND
 *     `messageHash == last_message_hash`   → no_op (byte-equal retry).
 *   - `nonce == last_nonce` but hash ≠     → reject stale_nonce.
 *   - `nonce < last_nonce`                  → reject stale_nonce.
 *
 * `messageHash` is a pure function of `(sender, nonce, contents)`, so
 * byte-equal retry ≡ same messageHash.
 */
export async function checkMonotonicity(
  sender: Address,
  nonce: bigint,
  messageHash: Bytes32,
  txn: StoreTxn
): Promise<MonotonicityOutcome> {
  const row = await txn.getNonce(sender);
  if (row === null) return { decision: 'accept' };
  if (nonce > row.lastNonce) return { decision: 'accept' };
  if (nonce === row.lastNonce) {
    if (messageHash.toLowerCase() === row.lastMessageHash.toLowerCase()) {
      return { decision: 'no_op', existingMessageHash: row.lastMessageHash };
    }
    return { decision: 'reject', reason: 'stale_nonce' };
  }
  return { decision: 'reject', reason: 'stale_nonce' };
}
