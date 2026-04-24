import type { Address, Bytes32 } from 'bam-sdk';

import type { MessageSnapshot } from '../types.js';

function bytesToHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}
function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** JSON-friendly encoding of v2 MessageSnapshots. */
export function encodeSnapshots(messages: MessageSnapshot[]): string {
  return JSON.stringify(
    messages.map((m) => ({
      sender: m.sender,
      nonce: m.nonce.toString(),
      contents: bytesToHex(m.contents),
      signature: bytesToHex(m.signature),
      messageHash: m.messageHash,
      messageId: m.messageId,
      originalIngestSeq: m.originalIngestSeq,
    }))
  );
}

export function decodeSnapshots(json: string): MessageSnapshot[] {
  if (json === '' || json === 'null') return [];
  const parsed = JSON.parse(json) as Array<{
    sender: string;
    nonce: string;
    contents: string;
    signature: string;
    messageHash: string;
    messageId: string | null;
    originalIngestSeq: number;
  }>;
  return parsed.map((m) => ({
    sender: m.sender as Address,
    nonce: BigInt(m.nonce),
    contents: hexToBytes(m.contents),
    signature: hexToBytes(m.signature),
    messageHash: m.messageHash as Bytes32,
    messageId: (m.messageId ?? null) as Bytes32 | null,
    originalIngestSeq: m.originalIngestSeq,
  }));
}
