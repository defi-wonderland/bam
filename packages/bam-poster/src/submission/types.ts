import type { Address, Bytes32 } from 'bam-sdk';

import type { DecodedMessage } from '../types.js';

/**
 * Result of a single on-chain submission attempt. `included` carries the
 * full on-chain coordinate `(blockNumber, txIndex)` so the substrate's
 * chain-derived ordering is fully populated and cursor pagination on
 * Poster-written rows behaves correctly. `submitter` is the signer
 * address that authorized the type-3 transaction — recorded on the
 * batch row so trust-audit views can attribute the submission without
 * re-querying L1.
 */
export type SubmitOutcome =
  | {
      kind: 'included';
      txHash: Bytes32;
      blockNumber: number;
      txIndex: number;
      blobVersionedHash: Bytes32;
      submitter: Address;
    }
  | { kind: 'retryable'; detail: string }
  | { kind: 'permanent'; detail: string };

export interface BuildAndSubmit {
  (args: {
    contentTag: Bytes32;
    messages: DecodedMessage[];
  }): Promise<SubmitOutcome>;
}
