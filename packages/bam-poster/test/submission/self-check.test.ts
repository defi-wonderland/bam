import { describe, expect, it } from 'vitest';
import {
  assembleMultiSegmentBlob,
  encodeBatch,
  generateECDSAPrivateKey,
  deriveAddress,
  encodeContents,
  signECDSAWithKey,
  hexToBytes,
  computeMessageHashForMessage,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import {
  PackSelfCheckMismatch,
  verifyPackedBlobRoundTrips,
} from '../../src/submission/self-check.js';
import type {
  AggregatorBatchSelection,
} from '../../src/submission/aggregator.js';
import type { PackPlan } from '../../src/submission/pack.js';
import type { DecodedMessage } from '../../src/types.js';

const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const CHAIN_ID = 11_155_111;

function makeSignedMessage(
  nonce: bigint,
  payload: Uint8Array,
  tag: Bytes32 = TAG_A
): { decoded: DecodedMessage; bam: BAMMessage; signature: Uint8Array } {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(tag, payload);
  const bam: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, bam, CHAIN_ID);
  const signature = hexToBytes(sigHex);
  const messageHash = computeMessageHashForMessage(bam);
  return {
    bam,
    signature,
    decoded: {
      sender,
      nonce,
      contents,
      signature,
      messageHash,
      ingestedAt: 0,
      ingestSeq: Number(nonce),
    },
  };
}

function buildPlanAndSelections(
  encodedA: Uint8Array,
  encodedB: Uint8Array,
  msgsA: DecodedMessage[],
  msgsB: DecodedMessage[]
): {
  blob: Uint8Array;
  plan: PackPlan;
  selections: Map<Bytes32, AggregatorBatchSelection>;
} {
  const { blob, segments } = assembleMultiSegmentBlob([
    { contentTag: TAG_A, payload: encodedA },
    { contentTag: TAG_B, payload: encodedB },
  ]);
  const plan: PackPlan = {
    included: [
      {
        contentTag: TAG_A,
        startFE: segments[0]!.startFE,
        endFE: segments[0]!.endFE,
        payloadBytes: encodedA,
      },
      {
        contentTag: TAG_B,
        startFE: segments[1]!.startFE,
        endFE: segments[1]!.endFE,
        payloadBytes: encodedB,
      },
    ],
    excluded: [],
  };
  const selections = new Map<Bytes32, AggregatorBatchSelection>();
  selections.set(TAG_A, {
    contentTag: TAG_A,
    messages: msgsA,
    payloadBytes: encodedA,
  });
  selections.set(TAG_B, {
    contentTag: TAG_B,
    messages: msgsB,
    payloadBytes: encodedB,
  });
  return { blob, plan, selections };
}

describe('verifyPackedBlobRoundTrips', () => {
  it('passes for a faithfully-assembled multi-tag blob', () => {
    const a1 = makeSignedMessage(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const a2 = makeSignedMessage(2n, new Uint8Array([4, 5, 6]), TAG_A);
    const b1 = makeSignedMessage(1n, new Uint8Array([7, 8, 9]), TAG_B);
    const encA = encodeBatch([a1.bam, a2.bam], [a1.signature, a2.signature]);
    const encB = encodeBatch([b1.bam], [b1.signature]);
    const { blob, plan, selections } = buildPlanAndSelections(
      encA.data,
      encB.data,
      [a1.decoded, a2.decoded],
      [b1.decoded]
    );

    expect(() => verifyPackedBlobRoundTrips(blob, plan, selections)).not.toThrow();
  });

  it('throws on a 1-byte tampered (startFE, endFE) — defense in depth', () => {
    const a1 = makeSignedMessage(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const b1 = makeSignedMessage(1n, new Uint8Array([7, 8, 9]), TAG_B);
    const encA = encodeBatch([a1.bam], [a1.signature]);
    const encB = encodeBatch([b1.bam], [b1.signature]);
    const { blob, plan, selections } = buildPlanAndSelections(
      encA.data,
      encB.data,
      [a1.decoded],
      [b1.decoded]
    );

    // Tamper with TAG_A's range — shift endFE one FE later. The
    // sliced bytes now include 31 bytes of TAG_B's encoded payload at
    // the tail; decode should still consume only encA.data length,
    // but the slice-bytes head check catches it because the sliced
    // FE-aligned bytes for the *original* head still match.
    //
    // To force a real mismatch, shift startFE forward instead — that
    // produces a slice whose head bytes do not equal encA.data.
    const tampered: PackPlan = {
      included: [
        { ...plan.included[0]!, startFE: plan.included[0]!.startFE + 1 },
        plan.included[1]!,
      ],
      excluded: [],
    };

    expect(() => verifyPackedBlobRoundTrips(blob, tampered, selections)).toThrow(
      PackSelfCheckMismatch
    );
  });

  it('throws when the producer claims a tag whose original is missing', () => {
    const a1 = makeSignedMessage(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const encA = encodeBatch([a1.bam], [a1.signature]);
    const { blob, segments } = assembleMultiSegmentBlob([
      { contentTag: TAG_A, payload: encA.data },
    ]);
    const plan: PackPlan = {
      included: [
        {
          contentTag: TAG_A,
          startFE: segments[0]!.startFE,
          endFE: segments[0]!.endFE,
          payloadBytes: encA.data,
        },
      ],
      excluded: [],
    };
    // No selections registered — a producer bug shape.
    const selections = new Map<Bytes32, AggregatorBatchSelection>();

    expect(() => verifyPackedBlobRoundTrips(blob, plan, selections)).toThrow(
      /no-matching-original-selection/
    );
  });
});
