/**
 * BAM v1 ABI batch codec — reference shape for the on-chain `ABIDecoder`.
 *
 * Wire format (matches `packages/bam-contracts/src/decoders/ABIDecoder.sol`):
 *
 *   payload = abi.encode(
 *     Message[] messages,    // tuple[](address sender, uint64 nonce, bytes contents)
 *     bytes signatureData    // concat(sig_0, sig_1, …, sig_{n-1}) — 65 bytes each
 *   )
 *
 *   len(sig_i)         == 65          // ECDSA — fixed
 *   len(signatureData) == 65 * n
 *
 * Empty payload (length 0) decodes to (empty[], empty) — matches the
 * Solidity decoder's `payload.length == 0` short-circuit.
 *
 * @module bam-sdk/codec/abi
 */

import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { bytesToHex, hexToBytes } from '../message.js';
import type { Address, BAMMessage } from '../types.js';

const SIGNATURE_BYTES = 65;

const BATCH_TUPLE_ABI = [
  {
    type: 'tuple[]',
    components: [
      { type: 'address', name: 'sender' },
      { type: 'uint64', name: 'nonce' },
      { type: 'bytes', name: 'contents' },
    ],
  },
  { type: 'bytes' },
] as const;

/**
 * Encode messages + parallel ECDSA signatures into the v1 ABI batch shape.
 *
 * Throws `RangeError` for caller bugs this function validates directly:
 * array length mismatch, non-65-byte signature, nonce out of uint64 range.
 * Sender shape is validated by viem's `encodeAbiParameters` and surfaces
 * as viem's own error type, not `RangeError`.
 */
export function encodeBatchABI(messages: BAMMessage[], signatures: Uint8Array[]): Uint8Array {
  if (messages.length !== signatures.length) {
    throw new RangeError(
      `messages and signatures must be parallel arrays (got ${messages.length} vs ${signatures.length})`
    );
  }
  if (messages.length === 0) {
    return new Uint8Array(0);
  }

  const sigBlob = new Uint8Array(SIGNATURE_BYTES * messages.length);
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    if (sig.length !== SIGNATURE_BYTES) {
      throw new RangeError(`signature ${i} must be 65 bytes (got ${sig.length})`);
    }
    sigBlob.set(sig, i * SIGNATURE_BYTES);
  }

  const messagesAbi = messages.map((m, i) => {
    if (m.nonce < 0n || m.nonce > 0xffffffffffffffffn) {
      throw new RangeError(`message ${i} nonce out of uint64 range`);
    }
    return {
      sender: m.sender,
      nonce: m.nonce,
      contents: bytesToHex(m.contents) as `0x${string}`,
    };
  });

  const hex = encodeAbiParameters(BATCH_TUPLE_ABI, [
    messagesAbi,
    bytesToHex(sigBlob) as `0x${string}`,
  ]);
  return hexToBytes(hex);
}

/**
 * Estimate the byte length `encodeBatchABI(messages, signatures)` will
 * produce, without actually allocating the encoded payload. The math
 * tracks viem's ABI head/tail layout for `(Message[], bytes)`:
 *
 *   - 64 B for the two top-level head offsets (Message[], bytes)
 *   - 32 B Message[] length prefix + 32·n B per-tuple offsets
 *   - 96 B per tuple head (sender + nonce + contents-offset)
 *   - 32 B tuple-tail length prefix + ⌈contents/32⌉·32 B padded bytes
 *   - 32 B signatureData length prefix + ⌈65n/32⌉·32 B padded sig bytes
 *
 * Returns 0 for an empty `messages` array — `encodeBatchABI` returns
 * an empty buffer in that case, and the policy's greedy walk needs the
 * estimator to agree (otherwise capacity gating drifts open-loop and
 * produces selections that won't fit once encoded).
 */
export function estimateBatchSizeABI(messages: BAMMessage[]): number {
  if (messages.length === 0) return 0;
  const n = messages.length;
  let total = 64; // 2 head offsets (Message[], bytes)
  total += 32; // Message[] length prefix
  total += 32 * n; // per-tuple offsets (each tuple is dynamic via bytes contents)
  for (const m of messages) {
    total += 96; // tuple head: address + uint64 + contents-offset
    total += 32; // tuple-tail: contents length prefix
    total += Math.ceil(m.contents.length / 32) * 32; // padded contents
  }
  total += 32; // signatureData length prefix
  total += Math.ceil((SIGNATURE_BYTES * n) / 32) * 32; // padded sigs
  return total;
}

/**
 * Decode a v1 ABI batch payload into messages + parallel ECDSA signatures.
 *
 * Empty input returns `{ messages: [], signatures: [] }` (no throw).
 * Throws `RangeError` on structural failure: malformed ABI envelope,
 * `signatureData.length` not divisible by 65, or
 * `signatureData.length / 65 != messages.length`.
 */
export function decodeBatchABI(data: Uint8Array): {
  messages: BAMMessage[];
  signatures: Uint8Array[];
} {
  if (data.length === 0) {
    return { messages: [], signatures: [] };
  }

  let raw: readonly [
    readonly { sender: Address; nonce: bigint; contents: `0x${string}` }[],
    `0x${string}`,
  ];
  try {
    raw = decodeAbiParameters(
      BATCH_TUPLE_ABI,
      bytesToHex(data) as `0x${string}`
    ) as typeof raw;
  } catch (err) {
    throw new RangeError(`malformed ABI batch payload: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const [messagesAbi, sigBlobHex] = raw;
  const sigBlob = hexToBytes(sigBlobHex);

  if (sigBlob.length % SIGNATURE_BYTES !== 0) {
    throw new RangeError(
      `signatureData length ${sigBlob.length} not divisible by ${SIGNATURE_BYTES}`
    );
  }
  const sigCount = sigBlob.length / SIGNATURE_BYTES;
  if (sigCount !== messagesAbi.length) {
    throw new RangeError(
      `signature count ${sigCount} does not match message count ${messagesAbi.length}`
    );
  }

  const messages: BAMMessage[] = messagesAbi.map((m) => ({
    sender: m.sender,
    nonce: m.nonce,
    contents: hexToBytes(m.contents),
  }));
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < sigCount; i++) {
    signatures.push(sigBlob.slice(i * SIGNATURE_BYTES, (i + 1) * SIGNATURE_BYTES));
  }

  return { messages, signatures };
}
