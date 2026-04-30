import type { Address } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import { decode } from '../../src/decode/dispatch.js';
import type { ReadContractClient } from '../../src/decode/on-chain-decoder.js';

/**
 * Liveness measurement for the on-chain-decoded path (red-team C-6).
 *
 * Constructs a worst-case-shaped batch within the 50M-gas-cap envelope
 * (~1024 messages, fixed-size contents) and runs it through the
 * Reader's `decode` dispatch with a fake `ReadContractClient`. The fake
 * client returns the pre-built decode result instantly, so this test
 * measures only the per-message work the Reader performs *after* the
 * `eth_call`: hex→bytes conversion, signature splitting, message
 * construction. That's the slice that scales with `messages.length`
 * and that an explicit cap would gate.
 *
 * Threshold: 5_000 ms — matches the existing
 * `READER_ETH_CALL_TIMEOUT_MS` default. If we cross it, the gas cap is
 * no longer the effective bound and an explicit `messages.length`
 * guard at dispatch becomes load-bearing (plan §Risks deferred).
 */
const NON_ZERO_DECODER = '0x000000000000000000000000000000000000abcd' as Address;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;
const LIVENESS_THRESHOLD_MS = 5_000;
const MESSAGE_COUNT = 1024;
const CONTENTS_LEN = 100;

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out as `0x${string}`;
}

describe('decode liveness on the on-chain path (C-6)', () => {
  it(`processes ${MESSAGE_COUNT}-message decode result under ${LIVENESS_THRESHOLD_MS}ms`, async () => {
    // Pre-build the decode result the fake client returns.
    const messages = new Array(MESSAGE_COUNT).fill(null).map((_, i) => {
      const contents = new Uint8Array(CONTENTS_LEN);
      // Deterministic but non-trivial bytes so length-based shortcuts
      // don't mask real per-byte work.
      for (let j = 0; j < CONTENTS_LEN; j++) contents[j] = (i + j * 13) & 0xff;
      return {
        sender: SENDER,
        nonce: BigInt(i + 1),
        contents: bytesToHex(contents),
      };
    });
    const sigData = new Uint8Array(MESSAGE_COUNT * 65);
    for (let i = 0; i < sigData.length; i++) sigData[i] = i & 0xff;

    const client: ReadContractClient = {
      // Returns instantly — the test measures the *post-call* work the
      // Reader does to convert the result into the dispatch shape.
      async readContract() {
        return [messages, bytesToHex(sigData)];
      },
    };

    const start = Date.now();
    const result = await decode({
      decoderAddress: NON_ZERO_DECODER,
      usableBytes: new Uint8Array([0xde, 0xad]),
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: LIVENESS_THRESHOLD_MS,
    });
    const wallclockMs = Date.now() - start;

    expect(result.messages.length).toBe(MESSAGE_COUNT);
    expect(result.signatures.length).toBe(MESSAGE_COUNT);
    // Surface the measurement in the test output regardless of pass/fail.
    // CI logs preserve this number for the plan's *Risks deferred*
    // measurement record.
    // eslint-disable-next-line no-console
    console.log(
      `[decode-liveness] ${MESSAGE_COUNT}-message decode wallclock: ${wallclockMs}ms ` +
        `(threshold ${LIVENESS_THRESHOLD_MS}ms)`
    );
    expect(
      wallclockMs,
      `decode of ${MESSAGE_COUNT}-message result took ${wallclockMs}ms ` +
        `(threshold ${LIVENESS_THRESHOLD_MS}ms). If this regresses, add an ` +
        `explicit messages.length cap at dispatch — see plan §Risks deferred.`
    ).toBeLessThan(LIVENESS_THRESHOLD_MS);
  });
});
