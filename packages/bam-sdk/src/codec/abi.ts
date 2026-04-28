/**
 * ERC-8180 spec-reference ABI batch codec.
 *
 * The SDK's primary batch codec (`bam-sdk/batch`) uses a compact custom
 * binary format with inline ECDSA signatures and a ZSTD codec byte. This
 * module is a parallel codec that emits the ERC-8180 §Decoder design
 * guidance recommended shape — `abi.encode(Message[] messages, bytes
 * signatureData)` — so a decoder living *on-chain* (e.g. `ABIDecoder.sol`)
 * can read the payload natively. Lower density, native EVM decode, useful
 * for spec-compliance demonstration and end-to-end exercise of the
 * non-zero decode dispatch path in the Reader.
 *
 * Inputs match `encodeBatch`: parallel `BAMMessage[]` and `Uint8Array[]`
 * scheme-0x01 ECDSA signatures (each 65 bytes). Output is a single
 * `Uint8Array` carrying the ABI-encoded tuple. `signatureData` is the
 * concatenation of the parallel sig array.
 *
 * @module bam-sdk/codec/abi
 */

import { decodeAbiParameters, encodeAbiParameters } from 'viem';

import type { Address, BAMMessage, HexBytes } from '../types.js';
import { bytesToHex, hexToBytes } from '../message.js';

const SIGNATURE_BYTES = 65;
const ADDRESS_BYTES = 20;

const ABI_PARAMS = [
  {
    type: 'tuple[]',
    name: 'messages',
    components: [
      { type: 'address', name: 'sender' },
      { type: 'uint64', name: 'nonce' },
      { type: 'bytes', name: 'contents' },
    ],
  },
  { type: 'bytes', name: 'signatureData' },
] as const;

/**
 * ABI-encode a parallel array of messages and scheme-0x01 signatures into
 * the ERC-8180 reference payload shape.
 *
 * Throws `RangeError` on input shape violations (length mismatch, non-65B
 * signatures, malformed sender, nonce out of range).
 */
export function encodeBatchABI(
  messages: BAMMessage[],
  signatures: Uint8Array[]
): Uint8Array {
  if (messages.length !== signatures.length) {
    throw new RangeError(
      `messages and signatures must be parallel arrays (got ${messages.length} vs ${signatures.length})`
    );
  }

  // Validate each input row before invoking the ABI codec — viem's
  // address parser is strict but throws less specific errors than the
  // existing binary encoder, and we want the two paths to surface the
  // same shape of complaint to callers.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sig = signatures[i];
    if (sig.length !== SIGNATURE_BYTES) {
      throw new RangeError(
        `signature ${i} must be ${SIGNATURE_BYTES} bytes (got ${sig.length})`
      );
    }
    const senderBytes = hexToBytes(m.sender);
    if (senderBytes.length !== ADDRESS_BYTES) {
      throw new RangeError(`message ${i} sender must be ${ADDRESS_BYTES} bytes`);
    }
    if (m.nonce < 0n || m.nonce > 0xffffffffffffffffn) {
      throw new RangeError(`message ${i} nonce out of uint64 range`);
    }
  }

  const tupleArgs = messages.map((m) => ({
    sender: m.sender,
    nonce: m.nonce,
    contents: bytesToHex(m.contents) as HexBytes,
  }));

  const sigData =
    signatures.length === 0
      ? new Uint8Array(0)
      : concatSigs(signatures);

  const encoded = encodeAbiParameters(ABI_PARAMS, [
    tupleArgs,
    bytesToHex(sigData) as HexBytes,
  ]);

  return hexToBytes(encoded);
}

/**
 * Decode an ABI-encoded batch payload back into the same shape returned by
 * `decodeBatch`: a `BAMMessage[]` with a parallel `Uint8Array[]` of 65-byte
 * scheme-0x01 ECDSA signatures.
 *
 * Throws on invalid ABI bytes or `signatureData.length !== 65 * messages.length`.
 */
export function decodeBatchABI(data: Uint8Array): {
  messages: BAMMessage[];
  signatures: Uint8Array[];
} {
  const decoded = decodeAbiParameters(
    ABI_PARAMS,
    bytesToHex(data) as HexBytes
  ) as readonly [
    readonly { sender: Address; nonce: bigint; contents: HexBytes }[],
    HexBytes,
  ];

  const [messageTuples, signatureDataHex] = decoded;
  const signatureData = hexToBytes(signatureDataHex);

  const expected = messageTuples.length * SIGNATURE_BYTES;
  if (signatureData.length !== expected) {
    throw new RangeError(
      `signatureData length ${signatureData.length} does not match ${messageTuples.length} × ${SIGNATURE_BYTES} = ${expected}`
    );
  }

  const messages: BAMMessage[] = messageTuples.map((m) => ({
    sender: m.sender,
    nonce: m.nonce,
    contents: hexToBytes(m.contents),
  }));

  const signatures: Uint8Array[] = [];
  for (let i = 0; i < messageTuples.length; i++) {
    signatures.push(
      new Uint8Array(
        signatureData.slice(i * SIGNATURE_BYTES, (i + 1) * SIGNATURE_BYTES)
      )
    );
  }

  return { messages, signatures };
}

function concatSigs(signatures: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(signatures.length * SIGNATURE_BYTES);
  for (let i = 0; i < signatures.length; i++) {
    out.set(signatures[i], i * SIGNATURE_BYTES);
  }
  return out;
}
