import { describe, expect, it } from 'vitest';
import {
  computeMessageHash,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import { defaultEcdsaValidator } from '../../src/validator/default-ecdsa.js';
import type { DecodedMessage } from '../../src/types.js';

const CHAIN_ID = 31337;
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const OTHER_TAG = ('0x' + 'bb'.repeat(32)) as Bytes32;

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildDecoded(opts: {
  nonce?: bigint;
  tamperBytes?: boolean;
  /** Tag the validator sees on the message (different = cross-app re-routing). */
  envelopeTag?: Bytes32;
  wrongSender?: Address;
  signatureOverride?: Uint8Array;
}): DecodedMessage {
  const nonce = opts.nonce ?? 1n;
  const contents = new TextEncoder().encode('hello');
  const msg: BAMMessage = { sender: SENDER, nonce, contents };
  // Sign for TAG; the envelope may declare OTHER_TAG when simulating a
  // cross-tag re-routing attempt.
  const sigHex = signECDSAWithKey(PRIV, msg, TAG, CHAIN_ID);
  const signature = opts.signatureOverride ?? hexToBytes(sigHex);

  let outContents = contents;
  if (opts.tamperBytes) {
    outContents = new Uint8Array(contents);
    outContents[0] ^= 0xff;
  }

  const contentTag = opts.envelopeTag ?? TAG;
  return {
    sender: opts.wrongSender ?? SENDER,
    nonce,
    contents: outContents,
    contentTag,
    signature,
    messageHash: computeMessageHash(SENDER, contentTag, nonce, outContents),
  };
}

describe('defaultEcdsaValidator', () => {
  const validator = defaultEcdsaValidator(CHAIN_ID);

  it('valid signature → ok', () => {
    const decoded = buildDecoded({});
    const result = validator.validate(decoded);
    expect(result.ok).toBe(true);
  });

  it('wrong chain id (validator built for a different chain) → bad_signature', () => {
    const validatorWrong = defaultEcdsaValidator(1);
    const decoded = buildDecoded({});
    const result = validatorWrong.validate(decoded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('cross-tag re-routing (envelope declares different tag than signed) → bad_signature', () => {
    const decoded = buildDecoded({ envelopeTag: OTHER_TAG });
    const result = validator.validate(decoded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('tampered contents → bad_signature', () => {
    const decoded = buildDecoded({ tamperBytes: true });
    const result = validator.validate(decoded);
    expect(result.ok).toBe(false);
  });

  it('wrong expected sender → bad_signature', () => {
    const decoded = buildDecoded({ wrongSender: ('0x' + '22'.repeat(20)) as Address });
    const result = validator.validate(decoded);
    expect(result.ok).toBe(false);
  });

  it('48-byte signature (BLS length) → bad_signature (cross-scheme safety)', () => {
    const decoded = buildDecoded({ signatureOverride: new Uint8Array(48) });
    const result = validator.validate(decoded);
    expect(result.ok).toBe(false);
  });

  it('recoverSigner returns the asserted sender when verification passes', () => {
    const decoded = buildDecoded({});
    const recovered = validator.recoverSigner?.(decoded);
    expect(recovered?.toLowerCase()).toBe(SENDER.toLowerCase());
  });

  it('recoverSigner returns null when the signature is invalid (rate-limit bypass guard)', () => {
    // Tampered contents ⇒ the signature no longer matches; recoverSigner
    // must reject so the ingest routes this envelope to the shared
    // RECOVER_FAILED rate-limit bucket instead of giving the attacker a
    // fresh per-sender budget.
    const decoded = buildDecoded({ tamperBytes: true });
    const recovered = validator.recoverSigner?.(decoded);
    expect(recovered).toBeNull();
  });

  it('recoverSigner returns null for wrong chain id', () => {
    const validatorWrong = defaultEcdsaValidator(1);
    const decoded = buildDecoded({});
    const recovered = validatorWrong.recoverSigner?.(decoded);
    expect(recovered).toBeNull();
  });

  it('recoverSigner returns null when signature length is wrong (cross-scheme safety)', () => {
    const decoded = buildDecoded({ signatureOverride: new Uint8Array(48) });
    const recovered = validator.recoverSigner?.(decoded);
    expect(recovered).toBeNull();
  });
});
