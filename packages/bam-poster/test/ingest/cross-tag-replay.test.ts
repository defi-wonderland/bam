import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  computeMessageHash,
  deriveBLSPublicKey,
  generateBLSPrivateKey,
  hexToBytes,
  signBLS,
  signECDSAWithKey,
  verifyBLS,
  verifyECDSA,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { defaultEcdsaValidator } from '../../src/validator/default-ecdsa.js';
import { createMemoryStore } from 'bam-store';

/**
 * Tag-binding soundness: a signed message bound to one `contentTag`
 * is rejected by any verifier reconstructing the hash with a
 * different `contentTag`. This is the new positive coverage of the
 * cross-app forgery fix; the file's previous content exercised the
 * old 32-byte prefix-binding mechanism that the rework removed.
 *
 * Both signature schemes the registry supports today are covered:
 *   - ECDSA (scheme 0x01) — binds `contentTag` via the EIP-712 struct.
 *   - BLS   (scheme 0x02) — binds `contentTag` via the `messageHash`
 *                            formula, transparently absorbed into the
 *                            `signedHash = keccak256(domain ‖ messageHash)`
 *                            identity.
 */

const CHAIN_ID = 31337;
const PRIV =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

function bytesToHexStr(b: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

describe('tag-binding soundness — ECDSA scheme (poster pipeline)', () => {
  async function mkPipeline() {
    const store = await createMemoryStore();
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 100 });
    const pipeline = new IngestPipeline({
      store,
      validator: defaultEcdsaValidator(CHAIN_ID),
      rateLimiter: limiter,
      allowlistedTags: [TAG_A, TAG_B],
      maxMessageSizeBytes: 120_000,
      maxContentsSizeBytes: 100_000,
      chainId: 1,
      now: () => new Date(0),
    });
    return pipeline;
  }

  function envelope(opts: { signedTag: Bytes32; envelopeTag: Bytes32 }): Uint8Array {
    const contents = new TextEncoder().encode('hi');
    const msg: BAMMessage = { sender: SENDER, nonce: 1n, contents };
    const signature = signECDSAWithKey(PRIV, msg, opts.signedTag, CHAIN_ID);
    return new TextEncoder().encode(
      JSON.stringify({
        contentTag: opts.envelopeTag,
        message: {
          sender: SENDER,
          nonce: '1',
          contents: bytesToHexStr(contents),
          signature,
        },
      })
    );
  }

  it('baseline: a correctly-tagged ECDSA message is accepted', async () => {
    const pipeline = await mkPipeline();
    const res = await pipeline.ingest(envelope({ signedTag: TAG_A, envelopeTag: TAG_A }));
    expect(res.accepted).toBe(true);
  });

  it('signed for tag A, submitted as tag B → rejected (bad_signature) — cross-app re-routing closed', async () => {
    const pipeline = await mkPipeline();
    const res = await pipeline.ingest(envelope({ signedTag: TAG_A, envelopeTag: TAG_B }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('bad_signature');
  });

  it('signed for tag B, submitted as tag A → rejected (bad_signature) — symmetry', async () => {
    const pipeline = await mkPipeline();
    const res = await pipeline.ingest(envelope({ signedTag: TAG_B, envelopeTag: TAG_A }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('bad_signature');
  });
});

describe('tag-binding soundness — direct verifier check (both schemes)', () => {
  const contents = new TextEncoder().encode('hi');
  const msg: BAMMessage = { sender: SENDER, nonce: 1n, contents };

  it('ECDSA: verifier reconstructing with the wrong contentTag rejects', () => {
    const sig = signECDSAWithKey(PRIV, msg, TAG_A, CHAIN_ID);
    expect(verifyECDSA(msg, TAG_A, sig, SENDER, CHAIN_ID)).toBe(true);
    expect(verifyECDSA(msg, TAG_B, sig, SENDER, CHAIN_ID)).toBe(false);
  });

  it('BLS: verifier reconstructing messageHash with the wrong contentTag rejects', async () => {
    // BLS path mirrors spec exactly: signedHash = keccak256(domain ‖ messageHash).
    // We rebuild that locally instead of going through a poster, since
    // BLS isn't wired through the ECDSA-only ingest path.
    //
    // Note on the call shape: `signBLS` / `verifyBLS` take the hash as
    // raw bytes via the @noble/bls12-381 backend's signing/verification
    // primitives — we go through them via the SDK's bytes-style helper
    // by passing `signedHashFor(tag)` as a hex string that the SDK then
    // forwards. The contentTag-binding property is the load-bearing
    // assertion; the hex/bytes plumbing is incidental.
    const domainBytes = keccak256(
      concat(
        new TextEncoder().encode('ERC-BAM.v1'),
        uint256BE(BigInt(CHAIN_ID))
      ),
      'bytes'
    );

    function signedHashBytesFor(tag: Bytes32): Uint8Array {
      const messageHash = computeMessageHash(SENDER, tag, 1n, contents);
      return keccak256(concat(domainBytes, hexToBytes(messageHash)), 'bytes');
    }

    const priv = generateBLSPrivateKey();
    const pub = deriveBLSPublicKey(priv);
    // signBLS / verifyBLS in bam-sdk forward to @noble/bls12-381 which
    // requires raw byte input — pass the bytes directly via the
    // Bytes32 cast (`bls.sign` accepts Uint8Array; the typed wrapper
    // erases that distinction).
    const sigA = await signBLS(priv, signedHashBytesFor(TAG_A) as unknown as Bytes32);

    expect(
      await verifyBLS(pub, signedHashBytesFor(TAG_A) as unknown as Bytes32, sigA)
    ).toBe(true);
    expect(
      await verifyBLS(pub, signedHashBytesFor(TAG_B) as unknown as Bytes32, sigA)
    ).toBe(false);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function uint256BE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
