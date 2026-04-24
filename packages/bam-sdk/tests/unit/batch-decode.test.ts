import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
import { decodeBatch, encodeBatch } from '../../src/batch.js';

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
function makeMessage(seed: number, contentsLen: number): BAMMessage {
  const sender = ('0x' + hex(seed).repeat(20)) as Address;
  const contents = new Uint8Array(contentsLen);
  for (let i = 0; i < contentsLen; i++) contents[i] = (seed + i * 7) & 0xff;
  return { sender, nonce: BigInt(seed * 1000 + 1), contents };
}

describe('decodeBatch', () => {
  it('round-trip: single message', () => {
    const msg = makeMessage(42, 80);
    const sig = new Uint8Array(65);
    for (let i = 0; i < 65; i++) sig[i] = i * 3 + 1;
    const batch = encodeBatch([msg], [sig]);
    const decoded = decodeBatch(batch.data);
    expect(decoded.messages.length).toBe(1);
    expect(decoded.messages[0].sender.toLowerCase()).toBe(msg.sender.toLowerCase());
    expect(decoded.messages[0].nonce).toBe(msg.nonce);
    expect(Array.from(decoded.messages[0].contents)).toEqual(Array.from(msg.contents));
    expect(Array.from(decoded.signatures[0])).toEqual(Array.from(sig));
  });

  it('round-trip: many messages with varying lengths', () => {
    const msgs: BAMMessage[] = [];
    const sigs: Uint8Array[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeMessage(i + 1, 32 + (i * 17) % 100));
      const sig = new Uint8Array(65);
      for (let k = 0; k < 65; k++) sig[k] = (i * 13 + k) & 0xff;
      sigs.push(sig);
    }
    const batch = encodeBatch(msgs, sigs);
    const decoded = decodeBatch(batch.data);
    expect(decoded.messages.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(decoded.messages[i].nonce).toBe(msgs[i].nonce);
      expect(Array.from(decoded.messages[i].contents)).toEqual(Array.from(msgs[i].contents));
      expect(Array.from(decoded.signatures[i])).toEqual(Array.from(sigs[i]));
    }
  });

  it('round-trip: zero messages', () => {
    const batch = encodeBatch([], []);
    const decoded = decodeBatch(batch.data);
    expect(decoded.messages).toEqual([]);
    expect(decoded.signatures).toEqual([]);
  });

  it('rejects truncated header', () => {
    expect(() => decodeBatch(new Uint8Array(5))).toThrow(RangeError);
  });

  it('rejects unknown version', () => {
    const data = new Uint8Array(10);
    data[0] = 0x99; // bogus version
    expect(() => decodeBatch(data)).toThrow(/version/);
  });

  it('rejects unknown codec id', () => {
    const data = new Uint8Array(10);
    data[0] = 0x02;
    data[1] = 0x77; // bogus codec
    expect(() => decodeBatch(data)).toThrow(/codec/);
  });

  it('rejects payload length past buffer', () => {
    const data = new Uint8Array(10);
    data[0] = 0x02;
    data[1] = 0x00;
    // messageCount = 1
    data[2] = 0; data[3] = 0; data[4] = 0; data[5] = 1;
    // payloadLen = 999 (way past end)
    data[6] = 0; data[7] = 0; data[8] = 0x03; data[9] = 0xe7;
    expect(() => decodeBatch(data)).toThrow(/past buffer/);
  });
});
