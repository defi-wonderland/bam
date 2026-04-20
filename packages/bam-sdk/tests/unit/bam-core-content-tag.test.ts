/**
 * BAM core `contentTag` round-trip tests.
 *
 * Verifies that the amended ABI (contentTag indexed at topic[3]) and the SDK types
 * carry the caller-supplied `contentTag` verbatim through encode → log → decode.
 * This is the SDK-side mirror of the Foundry tests in BlobAuthenticatedMessagingCore.t.sol.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeEventLog,
  encodeEventTopics,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
  type Log,
} from 'viem';
import { BAM_CORE_ABI } from '../../src/contracts/client.js';
import type {
  Address,
  Bytes32,
  BlobBatchRegisteredEvent,
  CalldataBatchRegisteredEvent,
} from '../../src/types.js';

const SOCIAL_BLOBS_TAG = keccak256(toBytes('social-blobs.v4')) as Bytes32;
const OTHER_TAG = keccak256(toBytes('other-protocol.v1')) as Bytes32;
const NULL_TAG = `0x${'00'.repeat(32)}` as Bytes32;

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const DECODER = '0x00000000000000000000000000000000dec0de01' as Address;
const SIG_REGISTRY = '0x0000000000000000000000000000000000516901' as Address;

const VERSIONED_HASH =
  '0x01deadbeef00000000000000000000000000000000000000000000000000beef' as Bytes32;
const CONTENT_HASH = keccak256(toBytes('batch-data')) as Bytes32;

/**
 * Build a synthetic Log matching what the BAM core emits. Encodes topics via viem's
 * `encodeEventTopics` and data via the non-indexed event args so the round-trip uses
 * the real ABI shape (not a hand-constructed topic list).
 */
function encodeBlobBatchLog(
  versionedHash: Bytes32,
  submitter: Address,
  contentTag: Bytes32,
  decoder: Address,
  signatureRegistry: Address
): Log {
  const topics = encodeEventTopics({
    abi: BAM_CORE_ABI,
    eventName: 'BlobBatchRegistered',
    args: { versionedHash, submitter, contentTag },
  });
  // Unindexed: decoder (address, 32 bytes padded), signatureRegistry (address, 32 bytes padded)
  const decoderPadded = decoder.slice(2).padStart(64, '0');
  const sigPadded = signatureRegistry.slice(2).padStart(64, '0');
  const data = (`0x${decoderPadded}${sigPadded}`) as `0x${string}`;
  return { topics, data } as unknown as Log;
}

function encodeCalldataBatchLog(
  contentHash: Bytes32,
  submitter: Address,
  contentTag: Bytes32,
  decoder: Address,
  signatureRegistry: Address
): Log {
  const topics = encodeEventTopics({
    abi: BAM_CORE_ABI,
    eventName: 'CalldataBatchRegistered',
    args: { contentHash, submitter, contentTag },
  });
  const decoderPadded = decoder.slice(2).padStart(64, '0');
  const sigPadded = signatureRegistry.slice(2).padStart(64, '0');
  const data = (`0x${decoderPadded}${sigPadded}`) as `0x${string}`;
  return { topics, data } as unknown as Log;
}

describe('BAM core contentTag round-trip (SDK ABI + types)', () => {
  describe('BlobBatchRegistered event', () => {
    it('emits contentTag as an indexed topic (topic[3])', () => {
      const log = encodeBlobBatchLog(
        VERSIONED_HASH,
        ALICE,
        SOCIAL_BLOBS_TAG,
        DECODER,
        SIG_REGISTRY
      );
      // topic[0] = event signature; [1] = versionedHash; [2] = submitter; [3] = contentTag
      expect(log.topics).toHaveLength(4);
      expect(log.topics[3]).toBe(SOCIAL_BLOBS_TAG);
    });

    it('round-trips a non-null contentTag verbatim', () => {
      const log = encodeBlobBatchLog(
        VERSIONED_HASH,
        ALICE,
        SOCIAL_BLOBS_TAG,
        DECODER,
        SIG_REGISTRY
      );
      const decoded = decodeEventLog({
        abi: BAM_CORE_ABI,
        topics: log.topics,
        data: log.data,
      });
      expect(decoded.eventName).toBe('BlobBatchRegistered');
      const args = decoded.args as unknown as BlobBatchRegisteredEvent;
      expect(args.versionedHash).toBe(VERSIONED_HASH);
      expect(args.submitter.toLowerCase()).toBe(ALICE.toLowerCase());
      expect(args.contentTag).toBe(SOCIAL_BLOBS_TAG);
      expect(args.decoder.toLowerCase()).toBe(DECODER.toLowerCase());
      expect(args.signatureRegistry.toLowerCase()).toBe(SIG_REGISTRY.toLowerCase());
    });

    it('round-trips bytes32(0) verbatim (null-tag acceptance mirrors Foundry)', () => {
      const log = encodeBlobBatchLog(VERSIONED_HASH, ALICE, NULL_TAG, DECODER, SIG_REGISTRY);
      const decoded = decodeEventLog({
        abi: BAM_CORE_ABI,
        topics: log.topics,
        data: log.data,
      });
      const args = decoded.args as unknown as BlobBatchRegisteredEvent;
      expect(args.contentTag).toBe(NULL_TAG);
    });

    it('different contentTag values decode distinctly', () => {
      const logA = encodeBlobBatchLog(VERSIONED_HASH, ALICE, SOCIAL_BLOBS_TAG, DECODER, SIG_REGISTRY);
      const logB = encodeBlobBatchLog(VERSIONED_HASH, ALICE, OTHER_TAG, DECODER, SIG_REGISTRY);
      const a = decodeEventLog({ abi: BAM_CORE_ABI, topics: logA.topics, data: logA.data });
      const b = decodeEventLog({ abi: BAM_CORE_ABI, topics: logB.topics, data: logB.data });
      expect((a.args as unknown as BlobBatchRegisteredEvent).contentTag).toBe(SOCIAL_BLOBS_TAG);
      expect((b.args as unknown as BlobBatchRegisteredEvent).contentTag).toBe(OTHER_TAG);
      expect((a.args as unknown as BlobBatchRegisteredEvent).contentTag).not.toBe(
        (b.args as unknown as BlobBatchRegisteredEvent).contentTag
      );
    });
  });

  describe('CalldataBatchRegistered event', () => {
    it('emits contentTag as an indexed topic (topic[3])', () => {
      const log = encodeCalldataBatchLog(
        CONTENT_HASH,
        ALICE,
        SOCIAL_BLOBS_TAG,
        DECODER,
        SIG_REGISTRY
      );
      expect(log.topics).toHaveLength(4);
      expect(log.topics[3]).toBe(SOCIAL_BLOBS_TAG);
    });

    it('round-trips a non-null contentTag verbatim', () => {
      const log = encodeCalldataBatchLog(
        CONTENT_HASH,
        ALICE,
        SOCIAL_BLOBS_TAG,
        DECODER,
        SIG_REGISTRY
      );
      const decoded = decodeEventLog({
        abi: BAM_CORE_ABI,
        topics: log.topics,
        data: log.data,
      });
      expect(decoded.eventName).toBe('CalldataBatchRegistered');
      const args = decoded.args as unknown as CalldataBatchRegisteredEvent;
      expect(args.contentHash).toBe(CONTENT_HASH);
      expect(args.submitter.toLowerCase()).toBe(ALICE.toLowerCase());
      expect(args.contentTag).toBe(SOCIAL_BLOBS_TAG);
      expect(args.decoder.toLowerCase()).toBe(DECODER.toLowerCase());
      expect(args.signatureRegistry.toLowerCase()).toBe(SIG_REGISTRY.toLowerCase());
    });

    it('round-trips bytes32(0) verbatim (null-tag acceptance mirrors Foundry)', () => {
      const log = encodeCalldataBatchLog(CONTENT_HASH, ALICE, NULL_TAG, DECODER, SIG_REGISTRY);
      const decoded = decodeEventLog({
        abi: BAM_CORE_ABI,
        topics: log.topics,
        data: log.data,
      });
      const args = decoded.args as unknown as CalldataBatchRegisteredEvent;
      expect(args.contentTag).toBe(NULL_TAG);
    });

    it('null-tag event still carries a distinct, non-zero event-signature topic', () => {
      const log = encodeCalldataBatchLog(CONTENT_HASH, ALICE, NULL_TAG, DECODER, SIG_REGISTRY);
      expect(log.topics[0]).not.toBe(NULL_TAG);
      expect(log.topics[0]).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('ABI wire-format break vs pre-amendment filters', () => {
    it('event signature topic0 changed (pre-amendment filters match zero logs)', () => {
      // The pre-amendment event was
      // BlobBatchRegistered(bytes32,address,address,address) — signature hash is distinct
      // from the amended BlobBatchRegistered(bytes32,address,bytes32,address,address).
      const preAmendmentTopic0 = keccak256(
        toBytes('BlobBatchRegistered(bytes32,address,address,address)')
      );
      const amendedTopic0 = keccak256(
        toBytes('BlobBatchRegistered(bytes32,address,bytes32,address,address)')
      );
      expect(preAmendmentTopic0).not.toBe(amendedTopic0);

      const log = encodeBlobBatchLog(
        VERSIONED_HASH,
        ALICE,
        SOCIAL_BLOBS_TAG,
        DECODER,
        SIG_REGISTRY
      );
      expect(log.topics[0]).toBe(amendedTopic0);
      expect(log.topics[0]).not.toBe(preAmendmentTopic0);
    });
  });

  describe('Topic-filter ergonomics (red-team C-7 mirror)', () => {
    it('filtering synthetic logs by contentTag topic[3] isolates the matching subset', () => {
      const logs = [
        encodeCalldataBatchLog(CONTENT_HASH, ALICE, SOCIAL_BLOBS_TAG, DECODER, SIG_REGISTRY),
        encodeCalldataBatchLog(CONTENT_HASH, ALICE, OTHER_TAG, DECODER, SIG_REGISTRY),
        encodeCalldataBatchLog(CONTENT_HASH, ALICE, SOCIAL_BLOBS_TAG, zeroAddress, SIG_REGISTRY),
      ];
      const matchSocial = logs.filter((l) => l.topics[3] === SOCIAL_BLOBS_TAG);
      const matchOther = logs.filter((l) => l.topics[3] === OTHER_TAG);
      const matchNone = logs.filter((l) => l.topics[3] === keccak256(toBytes('never-used')));
      expect(matchSocial).toHaveLength(2);
      expect(matchOther).toHaveLength(1);
      expect(matchNone).toHaveLength(0);
    });
  });

  describe('Type surface', () => {
    it('BlobBatchRegisteredEvent carries contentTag as a required field', () => {
      const event: BlobBatchRegisteredEvent = {
        versionedHash: VERSIONED_HASH,
        submitter: ALICE,
        contentTag: SOCIAL_BLOBS_TAG,
        decoder: DECODER,
        signatureRegistry: SIG_REGISTRY,
      };
      expect(event.contentTag).toBe(SOCIAL_BLOBS_TAG);
      expect(toHex(toBytes(event.contentTag)).length).toBe(66);
    });

    it('CalldataBatchRegisteredEvent carries contentTag as a required field', () => {
      const event: CalldataBatchRegisteredEvent = {
        contentHash: CONTENT_HASH,
        submitter: ALICE,
        contentTag: SOCIAL_BLOBS_TAG,
        decoder: DECODER,
        signatureRegistry: SIG_REGISTRY,
      };
      expect(event.contentTag).toBe(SOCIAL_BLOBS_TAG);
    });
  });
});
