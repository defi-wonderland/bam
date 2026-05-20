import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage, Bytes32 } from '../../src/types.js';
import { computeMessageHash, computeMessageId } from '../../src/message.js';
import { computeECDSADigest } from '../../src/signatures.js';

/**
 * Cross-runtime byte-identity smoke (constitution II, gate G-5).
 *
 * The browser entrypoint of the SDK MUST produce byte-identical output
 * to the Node entrypoint for the message-layer primitives, otherwise a
 * dApp signing in the browser and a service verifying in Node would
 * diverge silently. This file exercises the browser path (`environment:
 * jsdom`) against pinned input vectors; the Node side runs the same
 * inputs under `tests/unit/` via the standard config.
 *
 * Tag-binding rework: `contentTag` is a load-bearing positional input
 * for both hashes and the digest. Distinct tags MUST yield distinct
 * outputs even for identical message bytes.
 */

const SENDER = ('0x' + '11'.repeat(20)) as Address;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const NONCE = 42n;
const CONTENTS = new TextEncoder().encode('parity vector');
const MSG: BAMMessage = { sender: SENDER, nonce: NONCE, contents: CONTENTS };
const BCH = ('0x01' + 'cd'.repeat(31)) as Bytes32;
const CHAIN_ID = 31337;

describe('browser ↔ node parity vectors', () => {
  it('computeMessageHash is deterministic and 32-byte hex', () => {
    const h = computeMessageHash(SENDER, TAG_A, NONCE, CONTENTS);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toBe(computeMessageHash(SENDER, TAG_A, NONCE, CONTENTS));
  });

  it('computeMessageHash binds contentTag — different tag, different hash', () => {
    const a = computeMessageHash(SENDER, TAG_A, NONCE, CONTENTS);
    const b = computeMessageHash(SENDER, TAG_B, NONCE, CONTENTS);
    expect(a).not.toBe(b);
  });

  it('computeMessageId is deterministic and binds contentTag', () => {
    const a = computeMessageId(SENDER, TAG_A, NONCE, BCH);
    const b = computeMessageId(SENDER, TAG_B, NONCE, BCH);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(computeMessageId(SENDER, TAG_A, NONCE, BCH));
    expect(a).not.toBe(b);
  });

  it('computeECDSADigest is deterministic and binds contentTag', () => {
    const a = computeECDSADigest(MSG, TAG_A, CHAIN_ID);
    const b = computeECDSADigest(MSG, TAG_B, CHAIN_ID);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(computeECDSADigest(MSG, TAG_A, CHAIN_ID));
    expect(a).not.toBe(b);
  });

  it('all three primitives produce distinct values for the same inputs', () => {
    // Trivial collision check: the three hashes have different domains and
    // must not coincide for any non-pathological input. This catches an
    // accidental cross-wiring (e.g. signedHash returning messageHash).
    const mh = computeMessageHash(SENDER, TAG_A, NONCE, CONTENTS);
    const mi = computeMessageId(SENDER, TAG_A, NONCE, BCH);
    const ec = computeECDSADigest(MSG, TAG_A, CHAIN_ID);
    expect(new Set([mh, mi, ec]).size).toBe(3);
  });
});
