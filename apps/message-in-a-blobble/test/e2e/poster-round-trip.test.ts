import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  bytesToHex,
  computeMessageHash,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import { startHarness, type Harness } from './harness';

async function buildSignedPostBody(opts: {
  content?: string;
  nonce?: number;
  privateKey?: `0x${string}`;
} = {}): Promise<{
  body: { author: Address; timestamp: number; nonce: number; content: string; signature: string };
}> {
  const pk = (opts.privateKey ?? generateECDSAPrivateKey()) as `0x${string}`;
  const author = privateKeyToAccount(pk).address as Address;
  const timestamp = 1_700_000_000;
  const nonce = opts.nonce ?? 1;
  const content = opts.content ?? 'hello from the demo';
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  return {
    body: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
  };
}

describe('Demo e2e — Poster round trip (T027)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    vi.resetModules();
  });

  it('post → pending → flush → confirmed with no regression', async () => {
    const { body } = await buildSignedPostBody({ content: 'e2e message' });

    // POST /api/messages → Poster /submit
    const { POST } = await import('../../src/app/api/messages/route');
    const postReq = new NextRequest('http://localhost/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as { accepted: boolean; messageId: string };
    expect(postBody.accepted).toBe(true);

    // GET /api/messages → Poster /pending — message shows up
    const { GET } = await import('../../src/app/api/messages/route');
    const pendingRes = await GET();
    const pendingBody = (await pendingRes.json()) as { pending: Array<{ author: string }> };
    expect(pendingBody.pending).toHaveLength(1);
    expect(pendingBody.pending[0].author.toLowerCase()).toBe(body.author.toLowerCase());

    // Trigger submission by calling the Poster flush endpoint through
    // the demo's /api/post-blobble proxy. The harness wires a
    // `forceFlush` batch policy so the tick picks up the pending
    // message and hands it to `buildAndSubmit` (mocked to "include").
    const { POST: FLUSH } = await import('../../src/app/api/post-blobble/route');
    const flushRes = await FLUSH();
    expect(flushRes.status).toBe(200);
    expect(h.submissions()).toBe(1);

    // Pool is empty now.
    const pendingAfter = (await (await GET()).json()) as { pending: unknown[] };
    expect(pendingAfter.pending).toHaveLength(0);

    // GET /api/submitted-batches → Poster /submitted-batches
    const { GET: SUBMITTED } = await import(
      '../../src/app/api/submitted-batches/route'
    );
    const subReq = new NextRequest('http://localhost/api/submitted-batches');
    const subRes = await SUBMITTED(subReq);
    expect(subRes.status).toBe(200);
    const subBody = (await subRes.json()) as {
      batches: Array<{ status: string; txHash: string; messageIds: string[] }>;
    };
    expect(subBody.batches).toHaveLength(1);
    expect(subBody.batches[0].status).toBe('included');
    expect(subBody.batches[0].messageIds).toHaveLength(1);
    expect(subBody.batches[0].messageIds[0]).toBe(postBody.messageId);

    // GET /api/poster-status + /api/poster-health
    const { GET: STATUS } = await import('../../src/app/api/poster-status/route');
    const statusRes = await STATUS();
    expect(statusRes.status).toBe(200);

    const { GET: HEALTH } = await import('../../src/app/api/poster-health/route');
    const healthRes = await HEALTH();
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { health: { state: string } };
    expect(healthBody.health.state).toBe('ok');
  });
});
