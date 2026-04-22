/**
 * BAM Signature Utilities
 * @module bam-sdk/signatures
 *
 * This module provides BLS12-381 and ECDSA signature support for the BAM protocol.
 *
 * ## BLS12-381 Signatures
 *
 * - Uses min-pubkey variant (96-byte signatures in G2, 48-byte public keys in G1)
 * - Supports signature aggregation (N signatures → 1 signature)
 * - Requires on-chain BLS public key registry
 *
 * NOTE: This implementation uses the min-pubkey variant (what @noble/bls12-381 provides)
 * rather than min-sig, resulting in 96-byte signatures instead of 48-byte. This is still
 * efficient for aggregation, though slightly larger per-signature.
 *
 * ## ECDSA Signatures
 *
 * - Standard Ethereum secp256k1 (65-byte signatures)
 * - Compatible with existing wallets (MetaMask, etc.)
 * - Author address derived from public key
 *
 * @example
 * ```typescript
 * import { signBLS, verifyBLS, aggregateBLS } from 'bam-core/signatures';
 *
 * // BLS signing
 * const privateKey = generateBLSPrivateKey();
 * const publicKey = deriveBLSPublicKey(privateKey);
 * const signature = await signBLS(privateKey, messageHash);
 * const valid = await verifyBLS(publicKey, messageHash, signature);
 *
 * // BLS aggregation
 * const aggSig = aggregateBLS([sig1, sig2, sig3]);
 * const aggValid = await verifyAggregateBLS([pk1, pk2, pk3], [hash1, hash2, hash3], aggSig);
 * ```
 */

import * as bls from '@noble/bls12-381';
import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
// Use universal crypto API (works in both Node 20+ and browsers)

// Configure @noble/secp256k1 to use @noble/hashes for HMAC-SHA256
secp256k1.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp256k1.etc.concatBytes(...m));
import { encodeAbiParameters, keccak256 as viemKeccak256 } from 'viem';

import type { Address, Bytes32, HexBytes } from './types.js';
import { ECDSA_POP_DOMAIN } from './constants.js';
import { SignatureError } from './errors.js';

// Helper: bytes to hex string (with 0x prefix)
function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

// Helper: hex string to bytes
function fromHex(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

// Helper: derive Ethereum address from uncompressed public key (65 bytes with 04 prefix)
function publicKeyToAddress(publicKey: Uint8Array): string {
  // Remove the 04 prefix if present
  const key = publicKey.length === 65 ? publicKey.slice(1) : publicKey;
  const hash = keccak_256(key);
  // Take last 20 bytes
  const addressBytes = hash.slice(12);
  return '0x' + Buffer.from(addressBytes).toString('hex');
}

// Helper: convert Bytes32 (hex string) or Uint8Array to Uint8Array
function toBytes(input: Uint8Array | string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return fromHex(input);
}

// Helper: Ethereum signed message hash (EIP-191 personal_sign)
function hashMessage(messageBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const combined = new Uint8Array(prefix.length + messageBytes.length);
  combined.set(prefix);
  combined.set(messageBytes, prefix.length);
  return keccak_256(combined);
}

/**
 * BLS private key (32 bytes)
 */
export type BLSPrivateKey = Uint8Array;

/**
 * BLS public key (48 bytes, G1 point compressed)
 */
export type BLSPublicKey = Uint8Array;

/**
 * BLS signature (96 bytes, G2 point compressed)
 */
export type BLSSignature = Uint8Array;

/**
 * ECDSA private key (32 bytes)
 */
export type ECDSAPrivateKey = string; // hex string

/**
 * ECDSA signature (65 bytes: r + s + v)
 */
export type ECDSASignature = Uint8Array;

// =============================================================================
// BLS12-381 Signatures (min-sig variant)
// =============================================================================

/**
 * Generate a random BLS private key
 * @returns 32-byte private key
 */
export function generateBLSPrivateKey(): BLSPrivateKey {
  return bls.utils.randomPrivateKey();
}

/**
 * Derive BLS public key from private key
 * @param privateKey 32-byte private key
 * @returns 48-byte public key (G1 point, compressed)
 */
export function deriveBLSPublicKey(privateKey: BLSPrivateKey): BLSPublicKey {
  return bls.getPublicKey(privateKey);
}

/**
 * Sign a message hash with BLS private key
 * @param privateKey 32-byte private key
 * @param messageHash 32-byte message hash
 * @returns 96-byte signature (G2 point, compressed)
 */
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

/**
 * Verify a BLS signature
 * @param publicKey 48-byte public key (G1 point)
 * @param messageHash 32-byte message hash
 * @param signature 96-byte signature (G2 point)
 * @returns true if signature is valid
 */
export async function verifyBLS(
  publicKey: BLSPublicKey,
  messageHash: Bytes32,
  signature: BLSSignature
): Promise<boolean> {
  try {
    return await bls.verify(signature, messageHash, publicKey);
  } catch (error) {
    // Invalid signature format throws, treat as invalid
    return false;
  }
}

/**
 * Aggregate multiple BLS signatures into one
 * @param signatures Array of 96-byte signatures
 * @returns Single 96-byte aggregate signature
 */
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

/**
 * Verify an aggregate BLS signature
 * @param publicKeys Array of 48-byte public keys
 * @param messageHashes Array of 32-byte message hashes
 * @param aggregateSignature 96-byte aggregate signature
 * @returns true if aggregate signature is valid
 */
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
  } catch (error) {
    // Invalid signature/key format throws, treat as invalid
    return false;
  }
}

/**
 * Serialize BLS private key to hex string
 * @param privateKey 32-byte private key
 * @returns Hex string (with 0x prefix)
 */
export function serializeBLSPrivateKey(privateKey: BLSPrivateKey): string {
  return '0x' + Buffer.from(privateKey).toString('hex');
}

/**
 * Deserialize BLS private key from hex string
 * @param hex Hex string (with or without 0x prefix)
 * @returns 32-byte private key
 */
export function deserializeBLSPrivateKey(hex: string): BLSPrivateKey {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 64) {
    throw new SignatureError('BLS private key must be 32 bytes (64 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

/**
 * Serialize BLS public key to hex string
 * @param publicKey 48-byte public key
 * @returns Hex string (with 0x prefix)
 */
export function serializeBLSPublicKey(publicKey: BLSPublicKey): string {
  return '0x' + Buffer.from(publicKey).toString('hex');
}

/**
 * Deserialize BLS public key from hex string
 * @param hex Hex string (with or without 0x prefix)
 * @returns 48-byte public key
 */
export function deserializeBLSPublicKey(hex: string): BLSPublicKey {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 96) {
    throw new SignatureError('BLS public key must be 48 bytes (96 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

/**
 * Serialize BLS signature to hex string
 * @param signature 96-byte signature
 * @returns Hex string (with 0x prefix)
 */
export function serializeBLSSignature(signature: BLSSignature): string {
  return '0x' + Buffer.from(signature).toString('hex');
}

/**
 * Deserialize BLS signature from hex string
 * @param hex Hex string (with or without 0x prefix)
 * @returns 96-byte signature
 */
export function deserializeBLSSignature(hex: string): BLSSignature {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 192) {
    throw new SignatureError('BLS signature must be 96 bytes (192 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

// =============================================================================
// ECDSA Signatures (secp256k1, Ethereum standard)
// =============================================================================

/**
 * Generate a random ECDSA private key
 * @returns Hex string private key (with 0x prefix)
 */
export function generateECDSAPrivateKey(): ECDSAPrivateKey {
  const privBytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(privBytes);
}

/**
 * Derive Ethereum address from ECDSA private key
 * @param privateKey Hex string private key
 * @returns 20-byte Ethereum address
 */
export function deriveAddress(privateKey: ECDSAPrivateKey): Address {
  const privBytes = fromHex(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false); // uncompressed
  return publicKeyToAddress(pubKey) as Address;
}

/**
 * Sign a message hash with ECDSA private key
 * @param privateKey Hex string private key
 * @param messageHash 32-byte message hash
 * @returns 65-byte signature (r + s + v)
 */
export async function signECDSA(
  privateKey: ECDSAPrivateKey,
  messageHash: Bytes32
): Promise<ECDSASignature> {
  try {
    const privBytes = fromHex(privateKey);
    // EIP-191 personal_sign: hash the message bytes
    const msgBytes = toBytes(messageHash);
    const digest = hashMessage(msgBytes);

    const sig = secp256k1.sign(digest, privBytes);
    const sigBytes = sig.toCompactRawBytes();

    // r (32) + s (32) + v (1) = 65 bytes
    const result = new Uint8Array(65);
    result.set(sigBytes);
    result[64] = sig.recovery + 27; // Ethereum v = recovery + 27
    return result;
  } catch (error) {
    throw new SignatureError(
      `ECDSA signing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Verify an ECDSA signature
 * @param address Expected signer address
 * @param messageHash 32-byte message hash
 * @param signature 65-byte signature (r + s + v)
 * @returns true if signature is valid and matches address
 */
export function verifyECDSA(
  address: Address,
  messageHash: Bytes32,
  signature: ECDSASignature
): boolean {
  try {
    if (signature.length !== 65) {
      return false;
    }

    const recovered = recoverAddress(messageHash, signature);
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Recover address from ECDSA signature
 * @param messageHash 32-byte message hash
 * @param signature 65-byte signature
 * @returns Recovered Ethereum address
 */
export function recoverAddress(messageHash: Bytes32, signature: ECDSASignature): Address {
  try {
    if (signature.length !== 65) {
      throw new SignatureError('ECDSA signature must be 65 bytes');
    }

    const compact = signature.slice(0, 64);
    const v = signature[64];
    const recovery = v >= 27 ? v - 27 : v;

    const msgBytes = toBytes(messageHash);
    const digest = hashMessage(msgBytes);
    const sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
    const pubKey = sig.recoverPublicKey(digest);
    const uncompressed = pubKey.toRawBytes(false); // 65 bytes with 04 prefix
    return publicKeyToAddress(uncompressed) as Address;
  } catch (error) {
    if (error instanceof SignatureError) throw error;
    throw new SignatureError(
      `Address recovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Serialize ECDSA signature to hex string
 * @param signature 65-byte signature
 * @returns Hex string (with 0x prefix)
 */
export function serializeECDSASignature(signature: ECDSASignature): string {
  return '0x' + Buffer.from(signature).toString('hex');
}

/**
 * Deserialize ECDSA signature from hex string
 * @param hex Hex string (with or without 0x prefix)
 * @returns 65-byte signature
 */
export function deserializeECDSASignature(hex: string): ECDSASignature {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length !== 130) {
    throw new SignatureError('ECDSA signature must be 65 bytes (130 hex chars)');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Check if a value is a valid BLS private key
 * @param value Value to check
 * @returns true if valid 32-byte BLS private key
 */
export function isValidBLSPrivateKey(value: unknown): value is BLSPrivateKey {
  return value instanceof Uint8Array && value.length === 32;
}

/**
 * Check if a value is a valid BLS public key
 * @param value Value to check
 * @returns true if valid 48-byte BLS public key
 */
export function isValidBLSPublicKey(value: unknown): value is BLSPublicKey {
  return value instanceof Uint8Array && value.length === 48;
}

/**
 * Check if a value is a valid BLS signature
 * @param value Value to check
 * @returns true if valid 96-byte BLS signature
 */
export function isValidBLSSignature(value: unknown): value is BLSSignature {
  return value instanceof Uint8Array && value.length === 96;
}

/**
 * Check if a value is a valid ECDSA signature
 * @param value Value to check
 * @returns true if valid 65-byte ECDSA signature
 */
export function isValidECDSASignature(value: unknown): value is ECDSASignature {
  return value instanceof Uint8Array && value.length === 65;
}

// =============================================================================
// ECDSA — ERC-8180 scheme-0x01 registry envelope helpers
// =============================================================================

/**
 * Wrap a raw 32-byte hash in the EIP-191 `personal_sign` envelope.
 *
 * Computes `keccak256("\x19Ethereum Signed Message:\n32" || hash)`, which is
 * the exact digest `ecrecover` operates on when a wallet signed via
 * `personal_sign`. The third argument to the ECDSA registry's `verify` is
 * this post-envelope hash.
 *
 * @param hash 32-byte hash as 0x-prefixed hex string.
 * @returns post-envelope 32-byte hash as 0x-prefixed hex string.
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

/**
 * Attempt to recover the signer address of `hash` from a 65-byte raw
 * signature, mirroring `ECDSARegistry.sol`'s pure `ecrecover`-plus-OZ-
 * `ECDSA` path: rejects signatures with malformed length, non-canonical
 * `v`, high-s (EIP-2), or zero-address recovery. Returns `null` on any
 * rejection; never throws.
 */
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
    if (sig.hasHighS()) return null; // EIP-2 low-s enforcement.
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
 * Local mirror of `ECDSARegistry.verifyWithRegisteredKey`, matching its
 * keyed / keyless branching behaviour (red-team C-9 — SDK and contract
 * MUST agree byte-for-byte on the same inputs).
 *
 * @param params.owner     Owner address the message is attributed to.
 * @param params.hash      Post-envelope 32-byte hash (`ecrecover`'s digest).
 * @param params.signature 65-byte raw signature (r || s || v).
 * @param params.delegate  Optional bound delegate. When omitted (or
 *                         `undefined`), the helper runs the keyless branch
 *                         (recovered signer MUST equal `owner`). When
 *                         provided, runs the keyed branch (recovered signer
 *                         MUST equal `delegate`).
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

/**
 * Local verify that always runs the keyless branch (treats the caller's
 * `owner` as the expected signer, ignoring any registered delegate).
 *
 * Useful for reading pre-delegation message history — once an owner
 * registers a delegate, `verifyEcdsaLocal` without an explicit `delegate`
 * still branches keyless, but any consumer caching delegate state would
 * otherwise be tempted to always pass the current delegate. This helper
 * pins the verification to the owner's EOA identity (red-team C-11).
 */
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
 * Compute the ECDSA registry's PoP inner hash for a given (owner, chainId,
 * registry) tuple.
 *
 * Matches `keccak256(abi.encode("ERC-BAM-ECDSA-PoP.v1", chainId, registry,
 * owner))` in `ECDSARegistry.sol`. The returned hash is the pre-envelope
 * digest; wallets sign it wrapped in `personal_sign`, and the registry
 * recomputes that wrapping on-chain.
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
