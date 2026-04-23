import {
  bytesToHex,
  computeMessageHash,
  recoverAddress,
  verifyECDSA,
  type Address,
  type Bytes32,
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
      const hashHex = tryComputeHashHex(msg);
      if (hashHex === null) return { ok: false, reason: 'malformed' };
      const ok = verifyECDSA(msg.author as Address, hashHex, msg.signature);
      if (!ok) return { ok: false, reason: 'bad_signature' };
      return { ok: true };
    },
    recoverSigner(msg: DecodedMessage): Address | null {
      const hashHex = tryComputeHashHex(msg);
      if (hashHex === null) return null;
      try {
        return recoverAddress(hashHex, msg.signature);
      } catch {
        return null;
      }
    },
  };
}

function tryComputeHashHex(msg: DecodedMessage): Bytes32 | null {
  // The v1 on-the-wire message format caps `nonce` at uint16. The
  // Poster's internal representation widens to bigint to match
  // ERC-8180 §Nonce Semantics (uint64). Clamping here preserves the
  // demo's hash construction for v1 messages.
  if (msg.nonce > 0xffffn || msg.nonce < 0n) return null;
  const sdkMsg: Message = {
    author: msg.author,
    timestamp: msg.timestamp,
    nonce: Number(msg.nonce),
    content: msg.content,
  };
  try {
    return bytesToHex(computeMessageHash(sdkMsg)) as Bytes32;
  } catch {
    return null;
  }
}
