import { NextRequest, NextResponse } from 'next/server';
import { insertMessage, getMessages, getNextNonce } from '@/db';

export async function GET() {
  try {
    const messages = getMessages();
    return NextResponse.json({ messages });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { author, content, blsSignature } = body as {
      author: string;
      content: string;
      blsSignature: string;
    };

    if (!author || !content || !blsSignature) {
      return NextResponse.json(
        { error: 'Missing required fields: author, content, blsSignature' },
        { status: 400 }
      );
    }

    if (content.length > 280) {
      return NextResponse.json(
        { error: 'Content too long (max 280 chars)' },
        { status: 400 }
      );
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = getNextNonce(author);

    // Compute a deterministic message ID
    const messageId = `${author.toLowerCase()}-${nonce}-${timestamp}`;

    const msg = insertMessage({
      message_id: messageId,
      author: author.toLowerCase(),
      timestamp,
      nonce,
      content,
      bls_signature: blsSignature,
    });

    return NextResponse.json({
      message: msg,
      nonce,
      timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to store message:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
