import type { Bytes32 } from 'bam-sdk';

import type { DecodedMessage } from '../types.js';

/**
 * Result of a single on-chain submission attempt. `included` carries the
 * full on-chain coordinate `(blockNumber, txIndex)` so the substrate's
 * chain-derived ordering is fully populated and cursor pagination on
 * Poster-written rows behaves correctly.
 */
export type SubmitOutcome =
  | {
      kind: 'included';
      txHash: Bytes32;
      blockNumber: number;
      txIndex: number;
      blobVersionedHash: Bytes32;
    }
  | { kind: 'retryable'; detail: string }
  | { kind: 'permanent'; detail: string };

export interface BuildAndSubmit {
  (args: {
    contentTag: Bytes32;
    messages: DecodedMessage[];
  }): Promise<SubmitOutcome>;
}
