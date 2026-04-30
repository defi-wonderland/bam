import { describe, expect, it } from 'vitest';

import type { Address, BAMMessage } from '../../src/types.js';
// Browser entrypoint — both functions MUST be importable from `bam-sdk/browser`.
import { decodeBatchABI, encodeBatchABI } from '../../src/browser.js';
// Node entrypoint — used only to confirm byte parity with the browser run.
import { encodeBatchABI as encodeBatchABINode } from '../../src/index.js';

/**
 * Browser parity for the v1 ABI batch codec (C-11).
 *
 * Three assertions, per plan §Security impact:
 *   (a) both functions are importable from `bam-sdk/browser`
 *   (b) round-trip works in the browser environment
 *   (c) bytes match the Node side for the same input
 */
describe('codec-abi browser parity', () => {
  it('encodeBatchABI and decodeBatchABI are importable from bam-sdk/browser', () => {
    expect(typeof encodeBatchABI).toBe('function');
    expect(typeof decodeBatchABI).toBe('function');
  });

  const messages: BAMMessage[] = [
    {
      sender: ('0x' + '11'.repeat(20)) as Address,
      nonce: 1n,
      contents: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    },
    {
      sender: ('0x' + '22'.repeat(20)) as Address,
      nonce: 2n,
      contents: new Uint8Array([0xaa, 0xbb, 0xcc]),
    },
  ];
  const signatures: Uint8Array[] = [
    new Uint8Array(65).fill(0x33),
    new Uint8Array(65).fill(0x44),
  ];

  it('round-trip works on a representative input', () => {
    const data = encodeBatchABI(messages, signatures);
    const decoded = decodeBatchABI(data);
    expect(decoded.messages.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(decoded.messages[i].sender.toLowerCase()).toBe(messages[i].sender.toLowerCase());
      expect(decoded.messages[i].nonce).toBe(messages[i].nonce);
      expect(Array.from(decoded.messages[i].contents)).toEqual(Array.from(messages[i].contents));
      expect(Array.from(decoded.signatures[i])).toEqual(Array.from(signatures[i]));
    }
  });

  it('produces the same bytes as the Node entrypoint for the same input', () => {
    const browserBytes = encodeBatchABI(messages, signatures);
    const nodeBytes = encodeBatchABINode(messages, signatures);
    expect(browserBytes.length).toBe(nodeBytes.length);
    expect(Array.from(browserBytes)).toEqual(Array.from(nodeBytes));
  });
});
