import { NextRequest, NextResponse } from 'next/server';
import {
  verifyECDSA,
  hexToBytes,
  bytesToHex,
  computeMessageHash,
  computeMessageId,
} from 'bam-sdk';
import type { Address } from 'bam-sdk';
import { insertMessage, getMessages } from '@/db/queries';

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get('status') || undefined;
  const messages = getMessages(status);
  return NextResponse.json({ messages });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { author, timestamp, nonce, content, signature } = body;

    if (!author || !timestamp || nonce === undefined || !content || !signature) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (content.length > 280) {
      return NextResponse.json({ error: 'Message too long (max 280 chars)' }, { status: 400 });
    }

    // Reconstruct message hash and verify signature
    const msg = { author, timestamp, nonce, content };
    const messageHash = computeMessageHash(msg);
    const messageHashHex = bytesToHex(messageHash) as `0x${string}`;
    const sigBytes = hexToBytes(signature);

    const valid = verifyECDSA(author as Address, messageHashHex, sigBytes);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    const messageId = computeMessageId(msg);

    const stored = insertMessage({
      message_id: messageId,
      author,
      timestamp,
      nonce,
      content,
      signature,
    });

    return NextResponse.json({ message: stored }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('UNIQUE constraint')) {
      return NextResponse.json({ error: 'Message already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
