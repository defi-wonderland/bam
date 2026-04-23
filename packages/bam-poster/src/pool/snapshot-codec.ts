import type { Address, Bytes32 } from 'bam-sdk';

import type { MessageSnapshot } from '../types.js';

/** JSON-friendly encoding of a MessageSnapshot (bigint + Uint8Array → strings). */
export function encodeSnapshots(messages: MessageSnapshot[]): string {
  return JSON.stringify(
    messages.map((m) => ({
      messageId: m.messageId,
      author: m.author,
      nonce: m.nonce.toString(),
      timestamp: m.timestamp,
      content: m.content,
      signature: '0x' + Buffer.from(m.signature).toString('hex'),
      originalIngestSeq: m.originalIngestSeq,
    }))
  );
}

export function decodeSnapshots(json: string): MessageSnapshot[] {
  if (json === '' || json === 'null') return [];
  const parsed = JSON.parse(json) as Array<{
    messageId: string;
    author: string;
    nonce: string;
    timestamp: number;
    content: string;
    signature: string;
    originalIngestSeq: number;
  }>;
  return parsed.map((m) => {
    const hex = m.signature.startsWith('0x') ? m.signature.slice(2) : m.signature;
    const sig = new Uint8Array(hex.length / 2);
    for (let i = 0; i < sig.length; i++) {
      sig[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return {
      messageId: m.messageId as Bytes32,
      author: m.author as Address,
      nonce: BigInt(m.nonce),
      timestamp: m.timestamp,
      content: m.content,
      signature: sig,
      originalIngestSeq: m.originalIngestSeq,
    };
  });
}
