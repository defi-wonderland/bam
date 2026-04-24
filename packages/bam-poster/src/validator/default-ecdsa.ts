import { verifyECDSA, type Address } from 'bam-sdk';

import type { DecodedMessage, MessageValidator, ValidationResult } from '../types.js';

/**
 * Default validator for scheme 0x01 (ECDSA over EIP-712 typed data).
 *
 * The validator is pure: no I/O, no store access. All framing / size /
 * content-tag / nonce checks run earlier in the pipeline; this is the
 * last gate before pool insertion.
 *
 * The validator calls `verifyECDSA` directly against the sender bound
 * in the message. The EIP-712 domain is chain-bound, so a matching
 * `chainId` is required.
 *
 * Cross-scheme safety: `verifyECDSA` returns `false` for any signature
 * length ≠ 65 bytes, so a BLS signature routed through this validator
 * is rejected without touching `ecrecover`. The envelope parser
 * already rejects non-65-byte signatures earlier with `malformed`, so
 * reaching this code with a bad length is itself a caller bug.
 */
export function defaultEcdsaValidator(chainId: number): MessageValidator {
  return {
    validate(msg: DecodedMessage): ValidationResult {
      const sigHex = toHex(msg.signature);
      const ok = verifyECDSA(
        { sender: msg.sender, nonce: msg.nonce, contents: msg.contents },
        sigHex,
        msg.sender,
        chainId
      );
      return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
    },
    recoverSigner(msg: DecodedMessage): Address | null {
      // Rate-limit keying runs BEFORE `validate`, so we must
      // authenticate the signature here. Without this check, an
      // attacker with an invalid signature could rotate `msg.sender`
      // to spread load across fresh rate-limit buckets; the pipeline
      // routes `null` to a sentinel bucket that bounds that cost.
      const sigHex = toHex(msg.signature);
      const ok = verifyECDSA(
        { sender: msg.sender, nonce: msg.nonce, contents: msg.contents },
        sigHex,
        msg.sender,
        chainId
      );
      return ok ? msg.sender : null;
    },
  };
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}
