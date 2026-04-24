import { describe, it, expect } from 'vitest';
import { generateECDSAPrivateKey } from 'bam-sdk';

import { LocalEcdsaSigner } from '../../src/signer/local.js';

/**
 * Private-key pattern (exactly 64 hex chars, bounded so longer
 * hex strings — e.g. an uncompressed public key with 130 hex chars —
 * do not trip the grep).
 */
const PRIVATE_KEY_PATTERN = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

describe('LocalEcdsaSigner — private-key leak grep', () => {
  it('never leaks the private key through toString / toJSON / util.inspect over 1000 fuzzed configs', async () => {
    const util = await import('node:util');
    for (let i = 0; i < 1000; i++) {
      const pk = generateECDSAPrivateKey() as `0x${string}`;
      // Sanity: generated key must itself match the pattern — if not,
      // the grep is meaningless.
      expect(PRIVATE_KEY_PATTERN.test(pk)).toBe(true);

      const signer = new LocalEcdsaSigner(pk);

      const surfaces: string[] = [
        String(signer),
        JSON.stringify(signer),
        JSON.stringify({ signer }),
        util.inspect(signer, { depth: 5 }),
        util.inspect({ signer }, { depth: 5 }),
        `${signer}`,
        signer.toString(),
        JSON.stringify(signer.toJSON()),
      ];

      // Also exercise the Account surface — a misuse that asks the
      // viem account directly could hypothetically leak material.
      const account = signer.account();
      surfaces.push(
        util.inspect(account, { depth: 5 }),
        JSON.stringify({ address: account.address, source: account.source })
      );

      for (const out of surfaces) {
        // The output must not include the caller's private key
        // verbatim, and must not include ANY 64-hex string (generic
        // leak: whatever looks like a private key is suspect).
        expect(out).not.toContain(pk);
        expect(PRIVATE_KEY_PATTERN.test(out)).toBe(false);
      }
    }
  });

  it('throws on malformed private-key input', () => {
    expect(() => new LocalEcdsaSigner('0xabc' as `0x${string}`)).toThrow();
    expect(() => new LocalEcdsaSigner('not-hex' as `0x${string}`)).toThrow();
  });

  it('exposes the derived address through `account().address`', () => {
    const pk = generateECDSAPrivateKey();
    const signer = new LocalEcdsaSigner(pk as `0x${string}`);
    expect(signer.account().address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
