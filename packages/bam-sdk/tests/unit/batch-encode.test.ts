import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import { encodeBatch, estimateBatchSize } from '../../src/batch.js';

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function makeMessage(seed: number, contentsLen: number): BAMMessage {
  const sender = ('0x' + hex(seed).repeat(20)) as Address;
  const contents = new Uint8Array(contentsLen);
  for (let i = 0; i < contentsLen; i++) contents[i] = (seed + i) & 0xff;
  // Ensure first 32 bytes look like a tag (any bytes ok — protocol-opaque).
  return { sender, nonce: BigInt(seed * 1000 + 1), contents };
}

describe('encodeBatch', () => {
  it('encodes a single-message batch', () => {
    const msgs = [makeMessage(1, 40)];
    const sigs = [new Uint8Array(65)];
    const batch = encodeBatch(msgs, sigs);
    expect(batch.messageCount).toBe(1);
    expect(batch.size).toBe(batch.data.length);
    // Header (10) + record fixed overhead (97) + contents (40)
    expect(batch.data.length).toBe(10 + 97 + 40);
    // Version byte + codec byte
    expect(batch.data[0]).toBe(0x02);
    expect(batch.data[1]).toBe(0x00); // CODEC_NONE default
  });

  it('encodes a 100-message batch', () => {
    const msgs: BAMMessage[] = [];
    const sigs: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      msgs.push(makeMessage(i + 1, 50));
      sigs.push(new Uint8Array(65));
    }
    const batch = encodeBatch(msgs, sigs);
    expect(batch.messageCount).toBe(100);
    // 10 (header) + 100 * (97 + 50) = 14710
    expect(batch.data.length).toBe(10 + 100 * (97 + 50));
  });

  it('estimate is exact under CODEC_NONE default', () => {
    const msgs = [makeMessage(1, 40), makeMessage(2, 100)];
    const sigs = [new Uint8Array(65), new Uint8Array(65)];
    const est = estimateBatchSize(msgs);
    const batch = encodeBatch(msgs, sigs);
    expect(batch.data.length).toBe(est);
  });

  it('rejects mismatched message/signature array lengths', () => {
    expect(() => encodeBatch([makeMessage(1, 40)], [])).toThrow(RangeError);
  });

  it('rejects non-65-byte signatures', () => {
    expect(() => encodeBatch([makeMessage(1, 40)], [new Uint8Array(64)])).toThrow(
      RangeError
    );
  });

  it('rejects out-of-range nonces', () => {
    const bad: BAMMessage = {
      sender: ('0x' + '11'.repeat(20)) as Address,
      nonce: -1n,
      contents: new Uint8Array(32),
    };
    expect(() => encodeBatch([bad], [new Uint8Array(65)])).toThrow(RangeError);
  });

  it('rejects non-20-byte sender', () => {
    const bad: BAMMessage = {
      sender: '0x1234' as Address,
      nonce: 0n,
      contents: new Uint8Array(32),
    };
    expect(() => encodeBatch([bad], [new Uint8Array(65)])).toThrow(RangeError);
  });
});
