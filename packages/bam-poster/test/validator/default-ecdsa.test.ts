import { describe, it, expect } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  computeMessageId,
  deriveAddress,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';

import { defaultEcdsaValidator } from '../../src/validator/default-ecdsa.js';
import type { DecodedMessage } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

async function makeSigned(content: string, nonce = 1): Promise<DecodedMessage> {
  const pk = generateECDSAPrivateKey();
  const author = deriveAddress(pk);
  const timestamp = 1_700_000_000;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  const messageId = computeMessageId({ author, timestamp, nonce, content });
  return {
    author,
    timestamp,
    nonce: BigInt(nonce),
    content,
    contentTag: TAG,
    signature: sig,
    messageId,
    raw: new Uint8Array([1, 2, 3]),
  };
}

describe('defaultEcdsaValidator', () => {
  it('accepts a valid signature produced by the bam-sdk signer', async () => {
    const msg = await makeSigned('hello');
    const v = defaultEcdsaValidator();
    const res = v.validate(msg);
    expect(res.ok).toBe(true);
  });

  it('rejects a forged signature with bad_signature', async () => {
    const msg = await makeSigned('hello');
    // Flip a bit in the signature.
    const tampered = new Uint8Array(msg.signature);
    tampered[0] ^= 0xff;
    const v = defaultEcdsaValidator();
    const res = v.validate({ ...msg, signature: tampered });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects signatures signed by a different author', async () => {
    const msg = await makeSigned('hello');
    // Recover fails when we swap the claimed author.
    const otherAuthor = '0x1234567890123456789012345678901234567890' as Address;
    const v = defaultEcdsaValidator();
    const res = v.validate({ ...msg, author: otherAuthor });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects a signature over different content (hash mismatch)', async () => {
    const msg = await makeSigned('hello');
    const v = defaultEcdsaValidator();
    // Same signature, different content — hash no longer matches.
    const res = v.validate({ ...msg, content: 'tampered' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects nonces outside the v1 uint16 range with malformed', async () => {
    const msg = await makeSigned('hello');
    const v = defaultEcdsaValidator();
    const res = v.validate({ ...msg, nonce: 1n << 20n });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });
});
