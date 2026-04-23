import type { Bytes32 } from 'bam-sdk';

import type { DecodedMessage } from '../types.js';

/**
 * Result of a single on-chain submission attempt. `pending` means the
 * tx was broadcast but hasn't been mined yet — the submission loop
 * records the row and polls for inclusion separately.
 */
export type SubmitOutcome =
  | { kind: 'included'; txHash: Bytes32; blockNumber: number; blobVersionedHash: Bytes32 }
  | { kind: 'retryable'; detail: string }
  | { kind: 'permanent'; detail: string };

export interface BuildAndSubmit {
  (args: {
    contentTag: Bytes32;
    messages: DecodedMessage[];
  }): Promise<SubmitOutcome>;
}
