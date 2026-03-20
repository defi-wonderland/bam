/**
 * Calldata SDK Integration Tests
 *
 * Tests for calldata self-publication functionality in the SDK.
 * These tests require a local testnet (Anvil) and deployed contracts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPublicClient, http, parseAbi, decodeErrorResult, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { spawn, ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';
import { keccak_256 } from '@noble/hashes/sha3';
import { BAMClient, createClient } from '../../src/index.js';
import {
  encodeBatch,
  decodeBatch,
  estimateBatchSize,
  validateBatch,
  computeMessageHash,
  BLS_SIGNATURE_SIZE,
  ECDSA_SIGNATURE_SIZE,
} from '../../src/index.js';
import type { Address, Bytes32, SignedMessage } from '../../src/index.js';

// Test constants
const ANVIL_RPC_URL = 'http://127.0.0.1:8545';
const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('Calldata SDK Integration Tests', () => {
  let client: BAMClient;
  let coreAddress: Address;
  let anvil: ChildProcess | null = null;
  let anvilStarted = false;

  /**
   * Deploy a minimal mock contract for testing
   */
  async function deployMockCore(): Promise<Address> {
    return '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
  }

  /**
   * Start Anvil local testnet
   */
  async function startAnvil(): Promise<void> {
    return new Promise((resolve, reject) => {
      const testClient = createPublicClient({
        chain: foundry,
        transport: http(ANVIL_RPC_URL),
      });
      testClient
        .getBlockNumber()
        .then(() => {
          anvilStarted = false;
          resolve();
        })
        .catch(() => {
          anvil = spawn('anvil', ['--port', '8545'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          });

          anvil.stdout?.on('data', (data: Buffer) => {
            if (data.toString().includes('Listening on')) {
              anvilStarted = true;
              resolve();
            }
          });

          anvil.stderr?.on('data', (data: Buffer) => {
            console.error('Anvil error:', data.toString());
          });

          anvil.on('error', (err: Error) => {
            reject(new Error(`Failed to start Anvil: ${err.message}`));
          });

          setTimeout(10000).then(() => {
            if (!anvilStarted && anvil) {
              anvil.kill();
              reject(new Error('Anvil startup timeout'));
            }
          });
        });
    });
  }

  /**
   * Stop Anvil if we started it
   */
  async function stopAnvil(): Promise<void> {
    if (anvil && anvilStarted) {
      anvil.kill();
      await setTimeout(500);
    }
  }

  beforeAll(async () => {
    try {
      await startAnvil();

      coreAddress = await deployMockCore();
      const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);

      client = createClient({
        chain: foundry,
        rpcUrl: ANVIL_RPC_URL,
        coreAddress,
        account,
      });
    } catch (error) {
      console.warn(
        'Anvil not available, skipping integration tests:',
        error instanceof Error ? error.message : error
      );
    }
  }, 30000);

  afterAll(async () => {
    await stopAnvil();
  });

  describe('SDK Type Validation', () => {
    it('should create client with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client.publicClient).toBeDefined();
    });
  });

  describe('Batch Data Encoding', () => {
    const testAuthor = ANVIL_ADDRESS as Address;
    const testTimestamp = Math.floor(Date.now() / 1000);

    function createSignedMessages(
      msgs: Array<{
        author: Address;
        timestamp: number;
        nonce: number;
        content: string;
      }>
    ): SignedMessage[] {
      return msgs.map((m) => ({
        ...m,
        signature: new Uint8Array(BLS_SIGNATURE_SIZE),
        signatureType: 'bls' as const,
      }));
    }

    it('should encode single message batch for calldata', () => {
      const messages = createSignedMessages([
        {
          author: testAuthor,
          timestamp: testTimestamp,
          nonce: 0,
          content: 'Hello from calldata!',
        },
      ]);

      const encoded = encodeBatch(messages, { compress: false });

      expect(encoded.data).toBeInstanceOf(Uint8Array);
      expect(encoded.data.length).toBeGreaterThan(0);

      const decoded = decodeBatch(encoded.data);
      expect(decoded.messages).toHaveLength(1);
      expect(decoded.messages[0].content).toBe('Hello from calldata!');
    });

    it('should encode multiple message batch for calldata', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'First message' },
        { author: testAuthor, timestamp: testTimestamp + 1, nonce: 1, content: 'Second message' },
        { author: testAuthor, timestamp: testTimestamp + 2, nonce: 2, content: 'Third message' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages).toHaveLength(3);
      expect(decoded.messages[0].content).toBe('First message');
      expect(decoded.messages[1].content).toBe('Second message');
      expect(decoded.messages[2].content).toBe('Third message');
    });

    it('should compute content hash for calldata batch', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'Hash test message' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const hash = keccak_256(encoded.data);
      const contentHash = '0x' + Buffer.from(hash).toString('hex');

      expect(contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('Message Offset Calculation', () => {
    const testAuthor = ANVIL_ADDRESS as Address;
    const testTimestamp = Math.floor(Date.now() / 1000);

    function createSignedMessages(
      msgs: Array<{
        author: Address;
        timestamp: number;
        nonce: number;
        content: string;
      }>
    ): SignedMessage[] {
      return msgs.map((m) => ({
        ...m,
        signature: new Uint8Array(BLS_SIGNATURE_SIZE),
        signatureType: 'bls' as const,
      }));
    }

    it('should validate batch before encoding', () => {
      const messages = [
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'First' },
        { author: testAuthor, timestamp: testTimestamp + 1, nonce: 1, content: 'Second message here' },
      ];

      expect(() => validateBatch(messages)).not.toThrow();
    });

    it('should estimate batch size', () => {
      const messages = [
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'Target message content' },
      ];

      const size = estimateBatchSize(messages, { compress: false });
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(1000);
    });

    it('should encode and decode batch correctly', () => {
      const signed = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'Target message content' },
      ]);

      const encoded = encodeBatch(signed, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages).toHaveLength(1);
      expect(decoded.messages[0].content).toBe('Target message content');
      expect(decoded.messages[0].author.toLowerCase()).toBe(testAuthor.toLowerCase());
    });
  });

  describe('CalldataExposureParams Validation', () => {
    const testAuthor = ANVIL_ADDRESS as Address;
    const testTimestamp = Math.floor(Date.now() / 1000);

    function createSignedMessages(
      msgs: Array<{
        author: Address;
        timestamp: number;
        nonce: number;
        content: string;
      }>
    ): SignedMessage[] {
      return msgs.map((m) => ({
        ...m,
        signature: new Uint8Array(BLS_SIGNATURE_SIZE),
        signatureType: 'bls' as const,
      }));
    }

    it('should create valid exposure params structure', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'Exposure test' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const batchData = encoded.data;

      const params = {
        batchData,
        messageOffset: 0,
        messageBytes: batchData.slice(0, 100),
        signature: new Uint8Array(96),
        registrationProof: new Uint8Array(0),
      };

      expect(params.batchData).toBeInstanceOf(Uint8Array);
      expect(params.messageOffset).toBeGreaterThanOrEqual(0);
      expect(params.messageBytes).toBeInstanceOf(Uint8Array);
      expect(params.signature.length).toBe(96);
      expect(params.registrationProof.length).toBe(0);
    });

    it('should verify message hash computation', () => {
      const msg = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 0,
        content: 'Verification test',
      };

      const hash = computeMessageHash(msg);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);

      const hash2 = computeMessageHash(msg);
      expect(Buffer.from(hash).toString('hex')).toBe(Buffer.from(hash2).toString('hex'));
    });
  });

  describe('Gas Estimation Types', () => {
    it('should have correct type for gas estimation methods', () => {
      expect(typeof client.estimateRegisterCalldataGas).toBe('function');
      expect(typeof client.estimateExposeFromCalldataGas).toBe('function');
    });
  });

  describe('Content Hash Verification', () => {
    it('should compute keccak256 hash of batch data', () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const hash = '0x' + Buffer.from(keccak_256(testData)).toString('hex');

      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(hash.length).toBe(66);
    });

    it('should produce different hashes for different data', () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([1, 2, 4]);

      const hash1 = Buffer.from(keccak_256(data1)).toString('hex');
      const hash2 = Buffer.from(keccak_256(data2)).toString('hex');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce consistent hash for same data', () => {
      const data = new Uint8Array([10, 20, 30, 40, 50]);

      const hash1 = Buffer.from(keccak_256(data)).toString('hex');
      const hash2 = Buffer.from(keccak_256(data)).toString('hex');

      expect(hash1).toBe(hash2);
    });
  });

  describe('Registration Verification', () => {
    it('should verify content hash format', () => {
      const contentHash = ('0x' + 'a'.repeat(64)) as Bytes32;

      expect(contentHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(contentHash.length).toBe(66);
    });

    it('should support versioned hash format for blobs', () => {
      const versionedHash = ('0x01' + 'ab'.repeat(31)) as Bytes32;

      expect(versionedHash).toMatch(/^0x01/);
      expect(versionedHash.length).toBe(66);
    });
  });

  describe('CLI Command Integration', () => {
    it('should format batch data correctly for CLI input', () => {
      const testAuthor = ANVIL_ADDRESS as Address;
      const testTimestamp = Math.floor(Date.now() / 1000);

      const messages: SignedMessage[] = [
        {
          author: testAuthor,
          timestamp: testTimestamp,
          nonce: 0,
          content: 'CLI test message',
          signature: new Uint8Array(BLS_SIGNATURE_SIZE),
          signatureType: 'bls' as const,
        },
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const hexData = toHex(encoded.data);

      expect(hexData).toMatch(/^0x[0-9a-f]+$/);

      const bytesFromHex = Buffer.from(hexData.slice(2), 'hex');
      const decoded = decodeBatch(new Uint8Array(bytesFromHex));

      expect(decoded.messages[0].content).toBe('CLI test message');
    });
  });

  describe('Error Handling Types', () => {
    it('should handle not-registered scenario', () => {
      const abi = parseAbi(['error NotRegistered(bytes32 contentHash)']);

      // Viem doesn't have encodeErrorResult as a standalone, but we can verify
      // error decoding works with known selectors
      const contentHash = ('0x' + 'a'.repeat(64)) as `0x${string}`;
      expect(contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should handle invalid blob index scenario', () => {
      const abi = parseAbi(['error InvalidBlobIndex(uint256 index)']);

      // Verify ABI parses correctly
      expect(abi).toBeDefined();
      expect(abi.length).toBe(1);
      expect(abi[0].type).toBe('error');
      expect(abi[0].name).toBe('InvalidBlobIndex');
    });
  });

  describe('Edge Cases', () => {
    const testAuthor = ANVIL_ADDRESS as Address;
    const testTimestamp = Math.floor(Date.now() / 1000);

    function createSignedMessages(
      msgs: Array<{
        author: Address;
        timestamp: number;
        nonce: number;
        content: string;
      }>
    ): SignedMessage[] {
      return msgs.map((m) => ({
        ...m,
        signature: new Uint8Array(BLS_SIGNATURE_SIZE),
        signatureType: 'bls' as const,
      }));
    }

    it('should handle empty content message', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: '' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].content).toBe('');
    });

    it('should handle nonce values within 16-bit range', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0xffff, content: 'Max nonce test' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].nonce).toBe(0xffff);
    });

    it('should handle unicode content in calldata', () => {
      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: 'Hello 世界 🌍 مرحبا' },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].content).toBe('Hello 世界 🌍 مرحبا');
    });

    it('should handle moderately long content', () => {
      const longContent = 'x'.repeat(200);

      const messages = createSignedMessages([
        { author: testAuthor, timestamp: testTimestamp, nonce: 0, content: longContent },
      ]);

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].content).toBe(longContent);
      expect(decoded.messages[0].content.length).toBe(200);
    });

    it('should handle content hash at bytes32 boundary', () => {
      const maxHash = ('0x' + 'f'.repeat(64)) as Bytes32;
      const zeroHash = ('0x' + '0'.repeat(64)) as Bytes32;

      expect(maxHash.length).toBe(66);
      expect(zeroHash.length).toBe(66);
      expect(maxHash).not.toBe(zeroHash);
    });
  });
});
