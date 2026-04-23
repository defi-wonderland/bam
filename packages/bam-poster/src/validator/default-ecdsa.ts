import {
  bytesToHex,
  computeMessageHash,
  verifyECDSA,
  type Address,
  type Message,
} from 'bam-sdk';

import type { DecodedMessage, MessageValidator, ValidationResult } from '../types.js';

/**
 * Default validator: verifies the message's ECDSA signature against the
 * author using the **same domain-separated hash construction the demo
 * uses today** (per plan §Security impact → C-13).
 *
 * The validator is pure: no I/O, no store access. All framing / size /
 * content-tag / nonce checks run earlier in the pipeline; this is the
 * last gate before pool insertion.
 */
export function defaultEcdsaValidator(): MessageValidator {
  return {
    validate(msg: DecodedMessage): ValidationResult {
      // The v1 on-the-wire message format caps `nonce` at uint16. The
      // Poster's internal representation widens to bigint to match
      // ERC-8180 §Nonce Semantics (uint64). Clamping here preserves the
      // demo's hash construction for v1 messages.
      if (msg.nonce > 0xffffn || msg.nonce < 0n) {
        return { ok: false, reason: 'malformed' };
      }
      const sdkMsg: Message = {
        author: msg.author,
        timestamp: msg.timestamp,
        nonce: Number(msg.nonce),
        content: msg.content,
      };
      let hashBytes: Uint8Array;
      try {
        hashBytes = computeMessageHash(sdkMsg);
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      const hashHex = bytesToHex(hashBytes) as `0x${string}`;
      const ok = verifyECDSA(msg.author as Address, hashHex, msg.signature);
      if (!ok) return { ok: false, reason: 'bad_signature' };
      return { ok: true };
    },
  };
}
