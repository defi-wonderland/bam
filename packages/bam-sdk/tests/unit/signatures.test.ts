/**
 * Signature module tests
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateBLS,
  deriveAddress,
  deriveBLSPublicKey,
  deserializeBLSPrivateKey,
  deserializeBLSPublicKey,
  deserializeBLSSignature,
  deserializeECDSASignature,
  generateBLSPrivateKey,
  generateECDSAPrivateKey,
  isValidBLSPrivateKey,
  isValidBLSPublicKey,
  isValidBLSSignature,
  isValidECDSASignature,
  recoverAddress,
  serializeBLSPrivateKey,
  serializeBLSPublicKey,
  serializeBLSSignature,
  serializeECDSASignature,
  signBLS,
  signECDSA,
  verifyAggregateBLS,
  verifyBLS,
  verifyECDSA,
} from '../../src/index.js';

describe('BLS Signatures', () => {
  it('should generate valid BLS private key', () => {
    const privateKey = generateBLSPrivateKey();
    expect(isValidBLSPrivateKey(privateKey)).toBe(true);
    expect(privateKey.length).toBe(32);
  });

  it('should derive BLS public key from private key', () => {
    const privateKey = generateBLSPrivateKey();
    const publicKey = deriveBLSPublicKey(privateKey);
    expect(isValidBLSPublicKey(publicKey)).toBe(true);
    expect(publicKey.length).toBe(48); // G1 point, compressed
  });

  it('should sign and verify with BLS', async () => {
    const privateKey = generateBLSPrivateKey();
    const publicKey = deriveBLSPublicKey(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);

    const signature = await signBLS(privateKey, messageHash);
    expect(isValidBLSSignature(signature)).toBe(true);
    expect(signature.length).toBe(96);

    const valid = await verifyBLS(publicKey, messageHash, signature);
    expect(valid).toBe(true);
  });

  it('should reject invalid BLS signature', async () => {
    const privateKey = generateBLSPrivateKey();
    const publicKey = deriveBLSPublicKey(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);

    const signature = await signBLS(privateKey, messageHash);

    // Wrong message
    const wrongMessage = new Uint8Array(32).fill(0x99);
    const validWrongMessage = await verifyBLS(publicKey, wrongMessage, signature);
    expect(validWrongMessage).toBe(false);

    // Wrong public key
    const otherPrivateKey = generateBLSPrivateKey();
    const otherPublicKey = deriveBLSPublicKey(otherPrivateKey);
    const validWrongKey = await verifyBLS(otherPublicKey, messageHash, signature);
    expect(validWrongKey).toBe(false);
  });

  it('should aggregate BLS signatures', async () => {
    // Create 3 signers
    const privateKeys = [generateBLSPrivateKey(), generateBLSPrivateKey(), generateBLSPrivateKey()];
    const publicKeys = privateKeys.map((pk) => deriveBLSPublicKey(pk));

    // Each signs a different message
    const messageHashes = [
      new Uint8Array(32).fill(0x01),
      new Uint8Array(32).fill(0x02),
      new Uint8Array(32).fill(0x03),
    ];

    const signatures = await Promise.all(privateKeys.map((pk, i) => signBLS(pk, messageHashes[i])));

    // Aggregate signatures
    const aggregateSignature = aggregateBLS(signatures);
    expect(isValidBLSSignature(aggregateSignature)).toBe(true);
    expect(aggregateSignature.length).toBe(96);

    // Verify aggregate
    const valid = await verifyAggregateBLS(publicKeys, messageHashes, aggregateSignature);
    expect(valid).toBe(true);
  });

  it('should reject invalid aggregate BLS signature', async () => {
    const privateKeys = [generateBLSPrivateKey(), generateBLSPrivateKey()];
    const publicKeys = privateKeys.map((pk) => deriveBLSPublicKey(pk));

    const messageHashes = [new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0x02)];

    const signatures = await Promise.all(privateKeys.map((pk, i) => signBLS(pk, messageHashes[i])));

    const aggregateSignature = aggregateBLS(signatures);

    // Wrong message for first signer
    const wrongHashes = [new Uint8Array(32).fill(0x99), messageHashes[1]];

    const valid = await verifyAggregateBLS(publicKeys, wrongHashes, aggregateSignature);
    expect(valid).toBe(false);
  });

  it('should serialize and deserialize BLS keys and signatures', async () => {
    const privateKey = generateBLSPrivateKey();
    const publicKey = deriveBLSPublicKey(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);
    const signature = await signBLS(privateKey, messageHash);

    // Serialize
    const privateKeyHex = serializeBLSPrivateKey(privateKey);
    const publicKeyHex = serializeBLSPublicKey(publicKey);
    const signatureHex = serializeBLSSignature(signature);

    expect(privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(publicKeyHex).toMatch(/^0x[0-9a-f]{96}$/);
    expect(signatureHex).toMatch(/^0x[0-9a-f]{192}$/);

    // Deserialize
    const privateKey2 = deserializeBLSPrivateKey(privateKeyHex);
    const publicKey2 = deserializeBLSPublicKey(publicKeyHex);
    const signature2 = deserializeBLSSignature(signatureHex);

    expect(privateKey2).toEqual(privateKey);
    expect(publicKey2).toEqual(publicKey);
    expect(signature2).toEqual(signature);

    // Verify with deserialized keys
    const valid = await verifyBLS(publicKey2, messageHash, signature2);
    expect(valid).toBe(true);
  });
});

describe('ECDSA Signatures', () => {
  it('should generate valid ECDSA private key', () => {
    const privateKey = generateECDSAPrivateKey();
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should derive Ethereum address from private key', () => {
    const privateKey = generateECDSAPrivateKey();
    const address = deriveAddress(privateKey);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('should sign and verify with ECDSA', async () => {
    const privateKey = generateECDSAPrivateKey();
    const address = deriveAddress(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);

    const signature = await signECDSA(privateKey, messageHash);
    expect(isValidECDSASignature(signature)).toBe(true);
    expect(signature.length).toBe(65);

    const valid = verifyECDSA(address, messageHash, signature);
    expect(valid).toBe(true);
  });

  it('should reject invalid ECDSA signature', async () => {
    const privateKey = generateECDSAPrivateKey();
    const address = deriveAddress(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);

    const signature = await signECDSA(privateKey, messageHash);

    // Wrong message
    const wrongMessage = new Uint8Array(32).fill(0x99);
    const validWrongMessage = verifyECDSA(address, wrongMessage, signature);
    expect(validWrongMessage).toBe(false);

    // Wrong address
    const otherPrivateKey = generateECDSAPrivateKey();
    const otherAddress = deriveAddress(otherPrivateKey);
    const validWrongAddress = verifyECDSA(otherAddress, messageHash, signature);
    expect(validWrongAddress).toBe(false);
  });

  it('should recover address from ECDSA signature', async () => {
    const privateKey = generateECDSAPrivateKey();
    const address = deriveAddress(privateKey);
    const messageHash = new Uint8Array(32).fill(0x42);

    const signature = await signECDSA(privateKey, messageHash);
    const recoveredAddress = recoverAddress(messageHash, signature);

    expect(recoveredAddress.toLowerCase()).toBe(address.toLowerCase());
  });

  it('should serialize and deserialize ECDSA signature', async () => {
    const privateKey = generateECDSAPrivateKey();
    const messageHash = new Uint8Array(32).fill(0x42);
    const signature = await signECDSA(privateKey, messageHash);

    // Serialize
    const signatureHex = serializeECDSASignature(signature);
    expect(signatureHex).toMatch(/^0x[0-9a-f]{130}$/);

    // Deserialize
    const signature2 = deserializeECDSASignature(signatureHex);
    expect(signature2).toEqual(signature);

    // Verify with deserialized signature
    const address = deriveAddress(privateKey);
    const valid = verifyECDSA(address, messageHash, signature2);
    expect(valid).toBe(true);
  });
});

describe('Validation Functions', () => {
  it('should validate BLS private key', () => {
    const valid = new Uint8Array(32).fill(0x42);
    const invalid1 = new Uint8Array(31).fill(0x42);
    const invalid2 = new Uint8Array(33).fill(0x42);
    const invalid3 = 'not bytes';

    expect(isValidBLSPrivateKey(valid)).toBe(true);
    expect(isValidBLSPrivateKey(invalid1)).toBe(false);
    expect(isValidBLSPrivateKey(invalid2)).toBe(false);
    expect(isValidBLSPrivateKey(invalid3)).toBe(false);
  });

  it('should validate BLS public key', () => {
    const valid = new Uint8Array(48).fill(0x42);
    const invalid1 = new Uint8Array(47).fill(0x42);
    const invalid2 = new Uint8Array(49).fill(0x42);
    const invalid3 = 'not bytes';

    expect(isValidBLSPublicKey(valid)).toBe(true);
    expect(isValidBLSPublicKey(invalid1)).toBe(false);
    expect(isValidBLSPublicKey(invalid2)).toBe(false);
    expect(isValidBLSPublicKey(invalid3)).toBe(false);
  });

  it('should validate BLS signature', () => {
    const valid = new Uint8Array(96).fill(0x42);
    const invalid1 = new Uint8Array(95).fill(0x42);
    const invalid2 = new Uint8Array(97).fill(0x42);
    const invalid3 = 'not bytes';

    expect(isValidBLSSignature(valid)).toBe(true);
    expect(isValidBLSSignature(invalid1)).toBe(false);
    expect(isValidBLSSignature(invalid2)).toBe(false);
    expect(isValidBLSSignature(invalid3)).toBe(false);
  });

  it('should validate ECDSA signature', () => {
    const valid = new Uint8Array(65).fill(0x42);
    const invalid1 = new Uint8Array(64).fill(0x42);
    const invalid2 = new Uint8Array(66).fill(0x42);
    const invalid3 = 'not bytes';

    expect(isValidECDSASignature(valid)).toBe(true);
    expect(isValidECDSASignature(invalid1)).toBe(false);
    expect(isValidECDSASignature(invalid2)).toBe(false);
    expect(isValidECDSASignature(invalid3)).toBe(false);
  });
});
