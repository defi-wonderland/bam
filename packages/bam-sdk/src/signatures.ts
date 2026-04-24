/**
 * BAM signature primitives.
 *
 * Feature 002 consolidates the SDK's scheme-0x01 (ECDSA) signing onto
 * EIP-712 typed data over `BAMMessage`, with `chainId` in the domain;
 * wallet and headless callers share one signer construction and one
 * verifier. BLS primitives and ECDSA registry helpers remain here as
 * scheme-0x02 building blocks and on-chain-verify mirrors.
 *
 * @module bam-sdk/signatures
 */

import * as bls from '@noble/bls12-381';
import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeAbiParameters, hashTypedData, keccak256 as viemKeccak256, type WalletClient } from 'viem';

import type { Address, BAMMessage, Bytes32, HexBytes } from './types.js';
import { ECDSA_POP_DOMAIN } from './constants.js';
import { SignatureError } from './errors.js';
import { bytesToHex, hexToBytes } from './message.js';

// Configure @noble/secp256k1 to use @noble/hashes for HMAC-SHA256
// (required for synchronous signing).
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp256k1.etc.concatBytes(...m));

// ── Internal helpers ─────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

function publicKeyToAddress(publicKey: Uint8Array): string {
  const key = publicKey.length === 65 ? publicKey.slice(1) : publicKey;
  const hash = keccak_256(key);
  const addressBytes = hash.slice(12);
  return '0x' + Buffer.from(addressBytes).toString('hex');
}

// ── Type tags ────────────────────────────────────────────────────────────

/** BLS private key (32 bytes). */
export type BLSPrivateKey = Uint8Array;
/** BLS public key (48 bytes, G1 point compressed). */
export type BLSPublicKey = Uint8Array;
/** BLS signature (96 bytes, G2 point compressed). */
export type BLSSignature = Uint8Array;
/** ECDSA private key (32 bytes, hex string). */
export type ECDSAPrivateKey = string;
/** ECDSA signature (65 bytes: r + s + v). */
export type ECDSASignature = Uint8Array;

// ═════════════════════════════════════════════════════════════════════════
// ECDSA — scheme 0x01 (EIP-712 over BAMMessage)
// ═════════════════════════════════════════════════════════════════════════

/**
 * EIP-712 domain fields BAM uses for scheme 0x01.
 *
 * `chainId` is supplied per call so a single signer can sign for
 * multiple deployments. `verifyingContract` is intentionally absent: a
 * BAM self-publication claim is not a transaction targeted at a specific
 * contract, and embedding one would imply a relationship that doesn't
 * exist at the protocol layer. Some hardware wallets warn on the
 * omission; this is an accepted UX cost documented in the SDK README.
 */
export const EIP712_DOMAIN_NAME = 'BAM';
export const EIP712_DOMAIN_VERSION = '1';

/**
 * EIP-712 typed-data schema for a BAM message.
 */
export const EIP712_TYPES = {
  BAMMessage: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'contents', type: 'bytes' },
  ],
} as const;

/**
 * Compute the EIP-712 digest a scheme-0x01 signer signs. Chain-bound
 * by construction: the same `BAMMessage` on a different `chainId`
 * yields a different digest, so cross-chain signature replay is not
 * reachable.
 */
export function computeECDSADigest(message: BAMMessage, chainId: number): Bytes32 {
  return hashTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
    },
    types: EIP712_TYPES,
    primaryType: 'BAMMessage',
    message: {
      sender: message.sender,
      nonce: message.nonce,
      contents: bytesToHex(message.contents) as `0x${string}`,
    },
  });
}

/**
 * Headless ECDSA signing: sign the EIP-712 digest of `message` on
 * `chainId` with `privateKey`, returning a 65-byte hex signature with
 * canonical low-s (via @noble's default) and `v ∈ {27, 28}`.
 */
export function signECDSAWithKey(
  privateKey: `0x${string}`,
  message: BAMMessage,
  chainId: number
): `0x${string}` {
  try {
    const digest = computeECDSADigest(message, chainId);
    const digestBytes = hexToBytes(digest);
    const privBytes = hexToBytes(privateKey);
    const sig = secp256k1.sign(digestBytes, privBytes);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes());
    out[64] = sig.recovery + 27;
    return bytesToHex(out) as `0x${string}`;
  } catch (err) {
    throw new SignatureError(
      `ECDSA signing failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Wallet-path ECDSA signing: delegate to the wallet client's
 * `signTypedData` over the same domain + types as the headless path.
 * Normalises the returned `v` byte from viem's `{0, 1}` encoding to
 * BAM's canonical `{27, 28}`.
 */
export async function signECDSA(
  walletClient: WalletClient,
  message: BAMMessage
): Promise<`0x${string}`> {
  if (walletClient.account == null) {
    throw new SignatureError('walletClient.account is required for ECDSA signing');
  }
  const chainId = walletClient.chain?.id;
  if (typeof chainId !== 'number') {
    throw new SignatureError('walletClient.chain.id is required for ECDSA signing');
  }

  const raw = await walletClient.signTypedData({
    account: walletClient.account,
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
    },
    types: EIP712_TYPES,
    primaryType: 'BAMMessage',
    message: {
      sender: message.sender,
      nonce: message.nonce,
      contents: bytesToHex(message.contents) as `0x${string}`,
    },
  });

  return normalizeEcdsaV(raw);
}

/**
 * Verify an EIP-712-constructed ECDSA signature against
 * `expectedSender` on `chainId`. Returns `false` on every failure path
 * (wrong sender, tampered contents, tampered tag prefix, non-canonical
 * high-s, wrong chain id, length ≠ 65, non-hex). Never throws.
 */
export function verifyECDSA(
  message: BAMMessage,
  signature: `0x${string}`,
  expectedSender: Address,
  chainId: number
): boolean {
  try {
    const sigBytes = hexToBytes(signature);
    if (sigBytes.length !== 65) return false;

    const digest = hexToBytes(computeECDSADigest(message, chainId));
    const compact = sigBytes.slice(0, 64);
    const v = sigBytes[64];
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return false;

    const sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
    if (sig.hasHighS()) return false;

    const pubKey = sig.recoverPublicKey(digest);
    const uncompressed = pubKey.toRawBytes(false);
    const addrBytes = keccak_256(uncompressed.slice(1)).slice(12);
    const recovered = bytesToHex(addrBytes);
    return recovered.toLowerCase() === expectedSender.toLowerCase();
  } catch {
    return false;
  }
}

function normalizeEcdsaV(sig: `0x${string}`): `0x${string}` {
  const bytes = hexToBytes(sig);
  if (bytes.length !== 65) {
    throw new SignatureError(
      `wallet returned non-65-byte signature (got ${bytes.length})`
    );
  }
  const v = bytes[64];
  if (v === 0 || v === 1) {
    bytes[64] = v + 27;
  } else if (v !== 27 && v !== 28) {
    throw new SignatureError(`wallet returned non-canonical v byte 0x${v.toString(16)}`);
  }
  return bytesToHex(bytes) as `0x${string}`;
}

// ═════════════════════════════════════════════════════════════════════════
// BLS12-381 (min-pubkey variant) — scheme 0x02 building blocks
// ═════════════════════════════════════════════════════════════════════════

export function generateBLSPrivateKey(): BLSPrivateKey {
  return bls.utils.randomPrivateKey();
}

export function deriveBLSPublicKey(privateKey: BLSPrivateKey): BLSPublicKey {
  return bls.getPublicKey(privateKey);
}

export async function signBLS(
  privateKey: BLSPrivateKey,
  messageHash: Bytes32
): Promise<BLSSignature> {
  try {
    const signature = await bls.sign(messageHash, privateKey);
    return signature;
  } catch (error) {
    throw new SignatureError(
      `BLS signing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function verifyBLS(
  publicKey: BLSPublicKey,
  messageHash: Bytes32,
  signature: BLSSignature
): Promise<boolean> {
  try {
    return await bls.verify(signature, messageHash, publicKey);
  } catch {
    return false;
  }
}

export function aggregateBLS(signatures: BLSSignature[]): BLSSignature {
  if (signatures.length === 0) {
    throw new SignatureError('Cannot aggregate empty signature array');
  }
  try {
    return bls.aggregateSignatures(signatures);
  } catch (error) {
    throw new SignatureError(
      `BLS aggregation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function verifyAggregateBLS(
  publicKeys: BLSPublicKey[],
  messageHashes: Bytes32[],
  aggregateSignature: BLSSignature
): Promise<boolean> {
  if (publicKeys.length !== messageHashes.length) {
    throw new SignatureError('Public keys and message hashes must have same length');
  }
  if (publicKeys.length === 0) {
    throw new SignatureError('Cannot verify empty aggregate');
  }
  try {
    return await bls.verifyBatch(aggregateSignature, messageHashes, publicKeys);
  } catch {
    return false;
  }
}

export function serializeBLSPrivateKey(privateKey: BLSPrivateKey): string {
  return '0x' + Buffer.from(privateKey).toString('hex');
}

export function deserializeBLSPrivateKey(hex: string): BLSPrivateKey {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 64) {
    throw new SignatureError('BLS private key must be 32 bytes (64 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

export function serializeBLSPublicKey(publicKey: BLSPublicKey): string {
  return '0x' + Buffer.from(publicKey).toString('hex');
}

export function deserializeBLSPublicKey(hex: string): BLSPublicKey {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 96) {
    throw new SignatureError('BLS public key must be 48 bytes (96 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

export function serializeBLSSignature(signature: BLSSignature): string {
  return '0x' + Buffer.from(signature).toString('hex');
}

export function deserializeBLSSignature(hex: string): BLSSignature {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 192) {
    throw new SignatureError('BLS signature must be 96 bytes (192 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

// ═════════════════════════════════════════════════════════════════════════
// ECDSA key utilities
// ═════════════════════════════════════════════════════════════════════════

export function generateECDSAPrivateKey(): ECDSAPrivateKey {
  const privBytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(privBytes);
}

export function deriveAddress(privateKey: ECDSAPrivateKey): Address {
  const privBytes = fromHex(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false);
  return publicKeyToAddress(pubKey) as Address;
}

export function serializeECDSASignature(signature: ECDSASignature): string {
  return '0x' + Buffer.from(signature).toString('hex');
}

export function deserializeECDSASignature(hex: string): ECDSASignature {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 130) {
    throw new SignatureError('ECDSA signature must be 65 bytes (130 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

// ── Utilities ────────────────────────────────────────────────────────────

export function isValidBLSPrivateKey(value: unknown): value is BLSPrivateKey {
  return value instanceof Uint8Array && value.length === 32;
}
export function isValidBLSPublicKey(value: unknown): value is BLSPublicKey {
  return value instanceof Uint8Array && value.length === 48;
}
export function isValidBLSSignature(value: unknown): value is BLSSignature {
  return value instanceof Uint8Array && value.length === 96;
}
export function isValidECDSASignature(value: unknown): value is ECDSASignature {
  return value instanceof Uint8Array && value.length === 65;
}

// ═════════════════════════════════════════════════════════════════════════
// ECDSA registry envelope helpers (ERC-BAM on-chain-verify mirrors)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Wrap a raw 32-byte hash in the EIP-191 `personal_sign` envelope.
 *
 * Computes `keccak256("\x19Ethereum Signed Message:\n32" || hash)`,
 * which is the digest `ecrecover` operates on when a wallet signs via
 * `personal_sign`. The third argument to the ECDSA registry's `verify`
 * is this post-envelope hash.
 */
export function wrapPersonalSign(hash: HexBytes): HexBytes {
  const bytes = fromHex(hash);
  if (bytes.length !== 32) {
    throw new SignatureError(`wrapPersonalSign requires a 32-byte hash (got ${bytes.length})`);
  }
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix);
  out.set(bytes, prefix.length);
  return toHex(keccak_256(out)) as HexBytes;
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

function tryRecoverLikeRegistry(hash: HexBytes, signature: Uint8Array): Address | null {
  if (signature.length !== 65) return null;
  const v = signature[64];
  if (v !== 27 && v !== 28) return null;

  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);

  try {
    const sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(v - 27);
    if (sig.hasHighS()) return null;
    const msg = fromHex(hash);
    if (msg.length !== 32) return null;
    const pubKey = sig.recoverPublicKey(msg);
    const uncompressed = pubKey.toRawBytes(false);
    const addr = publicKeyToAddress(uncompressed).toLowerCase() as Address;
    if (addr === ZERO_ADDRESS) return null;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Local mirror of `ECDSARegistry.verifyWithRegisteredKey`.
 */
export function verifyEcdsaLocal(params: {
  owner: Address;
  hash: HexBytes;
  signature: Uint8Array;
  delegate?: Address;
}): boolean {
  const expected = params.delegate ?? params.owner;
  if ((expected.toLowerCase() as Address) === ZERO_ADDRESS) return false;
  const recovered = tryRecoverLikeRegistry(params.hash, params.signature);
  if (recovered === null) return false;
  return recovered === (expected.toLowerCase() as Address);
}

/** Keyless-branch variant of `verifyEcdsaLocal`. */
export function verifyEcdsaAsEOA(params: {
  owner: Address;
  hash: HexBytes;
  signature: Uint8Array;
}): boolean {
  if ((params.owner.toLowerCase() as Address) === ZERO_ADDRESS) return false;
  const recovered = tryRecoverLikeRegistry(params.hash, params.signature);
  if (recovered === null) return false;
  return recovered === (params.owner.toLowerCase() as Address);
}

/**
 * Compute the ECDSA registry's PoP inner hash for `(owner, chainId,
 * registry)`. Matches `keccak256(abi.encode(ECDSA_POP_DOMAIN, chainId,
 * registry, owner))` in `ECDSARegistry.sol`.
 */
export function computeEcdsaPopMessage(params: {
  owner: Address;
  chainId: number | bigint;
  registry: Address;
}): HexBytes {
  const encoded = encodeAbiParameters(
    [
      { type: 'string' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
    ],
    [ECDSA_POP_DOMAIN, BigInt(params.chainId), params.registry, params.owner]
  );
  return viemKeccak256(encoded) as HexBytes;
}
