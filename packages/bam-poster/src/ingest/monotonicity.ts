import type { Address, Bytes32 } from 'bam-sdk';

import type { StoreTxn } from '../types.js';
import type { PosterRejection } from '../errors.js';

export type MonotonicityOutcome =
  | { decision: 'accept' }
  | { decision: 'no_op'; existingMessageId: Bytes32 }
  | { decision: 'reject'; reason: PosterRejection };

/**
 * ERC-8180 §Nonce Semantics enforcement, scoped **per sender across all
 * content tags** the Poster serves (plan §C-11; the ERC's signing
 * domain binds `(sender, nonce, contents)` without a content tag).
 *
 * Behavior on an ingest with `(author, nonce)`:
 *   - No last-accepted record        → accept.
 *   - `nonce > last_nonce`           → accept.
 *   - `nonce == last_nonce` AND
 *     `messageId == last_message_id` → no_op (byte-equal retry).
 *   - `nonce == last_nonce` but id ≠ → reject stale_nonce.
 *   - `nonce < last_nonce`           → reject stale_nonce.
 *
 * This is a read — the caller records the new `(author, nonce, id)`
 * after the full pipeline succeeds, inside the same `withTxn`.
 */
export async function checkMonotonicity(
  author: Address,
  nonce: bigint,
  messageId: Bytes32,
  txn: StoreTxn
): Promise<MonotonicityOutcome> {
  const row = await txn.getNonce(author);
  if (row === null) return { decision: 'accept' };
  if (nonce > row.lastNonce) return { decision: 'accept' };
  if (nonce === row.lastNonce) {
    if (messageId.toLowerCase() === row.lastMessageId.toLowerCase()) {
      return { decision: 'no_op', existingMessageId: row.lastMessageId };
    }
    return { decision: 'reject', reason: 'stale_nonce' };
  }
  return { decision: 'reject', reason: 'stale_nonce' };
}
