import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { HttpServer } from '../../src/http/server.js';
import type {
  Health,
  Pending,
  Poster,
  Status,
  SubmitHint,
  SubmitResult,
  SubmittedBatch,
} from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const WALLET = ('0x' + '99'.repeat(20)) as Address;

interface StubOverrides {
  submit?: (raw: Uint8Array, hint?: SubmitHint) => Promise<SubmitResult>;
  pending?: Pending[];
  submittedBatches?: SubmittedBatch[];
  status?: Status;
  health?: Health;
}

function stubPoster(o: StubOverrides = {}): Poster {
  return {
    async submit(raw, hint) {
      return (
        o.submit?.(raw, hint) ??
        Promise.resolve({ accepted: true, messageHash: ('0x' + 'aa'.repeat(32)) as Bytes32 })
      );
    },
    async listPending() {
      return o.pending ?? [];
    },
    async listSubmittedBatches() {
      return o.submittedBatches ?? [];
    },
    async status() {
      return (
        o.status ?? {
          walletAddress: WALLET,
          walletBalanceWei: 0n,
          configuredTags: [TAG],
          pendingByTag: [{ contentTag: TAG, count: 0 }],
          lastSubmittedByTag: [],
        }
      );
    },
    async health() {
      return o.health ?? { state: 'ok' };
    },
    async start() {},
    async stop() {},
  };
}

const servers: HttpServer[] = [];

async function newServer(opts: {
  poster: Poster;
  maxMessageSizeBytes?: number;
  authToken?: string;
}): Promise<{ baseUrl: string; server: HttpServer }> {
  const server = new HttpServer({
    poster: opts.poster,
    maxMessageSizeBytes: opts.maxMessageSizeBytes ?? 10_000,
    authToken: opts.authToken,
  });
  servers.push(server);
  await server.listen(0);
  const addr = server.address()!;
  return { server, baseUrl: `http://${addr.address}:${addr.port}` };
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe('HttpServer — /submit', () => {
  it('accepts v2 envelope and returns messageHash', async () => {
    const hash = ('0x' + 'cd'.repeat(32)) as Bytes32;
    const { baseUrl } = await newServer({
      poster: stubPoster({
        async submit() {
          return { accepted: true, messageHash: hash };
        },
      }),
    });
    const res = await fetch(`${baseUrl}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accepted: boolean; messageHash: string };
    expect(body.accepted).toBe(true);
    expect(body.messageHash).toBe(hash);
  });

  it('rejection body carries `reason` with stable enum value', async () => {
    const { baseUrl } = await newServer({
      poster: stubPoster({
        async submit() {
          return { accepted: false, reason: 'bad_signature' };
        },
      }),
    });
    const res = await fetch(`${baseUrl}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { accepted: boolean; reason: string };
    expect(body).toEqual({ accepted: false, reason: 'bad_signature' });
  });

  it('oversized body → 413 message_too_large before poster.submit runs', async () => {
    let submitCalled = false;
    const { baseUrl } = await newServer({
      maxMessageSizeBytes: 128,
      poster: stubPoster({
        async submit() {
          submitCalled = true;
          return { accepted: true, messageHash: ('0x' + '00'.repeat(32)) as Bytes32 };
        },
      }),
    });
    const bigBody = 'x'.repeat(10_000);
    const res = await fetch(`${baseUrl}/submit`, {
      method: 'POST',
      body: bigBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { accepted: boolean; reason: string };
    expect(body.reason).toBe('message_too_large');
    expect(submitCalled).toBe(false);
  });
});

describe('HttpServer — GET surfaces', () => {
  it('/pending returns { pending: [] }', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/pending?contentTag=${TAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: unknown[] };
    expect(Array.isArray(body.pending)).toBe(true);
  });

  it('/pending?limit=abc → 400 invalid_query', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/pending?limit=abc`);
    expect(res.status).toBe(400);
  });

  it('/submitted-batches returns { batches: [] }', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/submitted-batches`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batches: unknown[] };
    expect(Array.isArray(body.batches)).toBe(true);
  });

  it('/submitted-batches?sinceBlock=abc → 400 invalid_query', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/submitted-batches?sinceBlock=abc`);
    expect(res.status).toBe(400);
  });

  it('/status wraps the poster.status() payload', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: { walletAddress: string } };
    expect(body.status.walletAddress).toBe(WALLET);
  });

  it('/health ok → 200', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('/health unhealthy → 503', async () => {
    const { baseUrl } = await newServer({
      poster: stubPoster({
        health: { state: 'unhealthy', reason: 'abi_mismatch' },
      }),
    });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
  });
});

describe('HttpServer — unknown routes + auth', () => {
  it('unknown path → 404 with error:not_found (not a PosterRejection)', async () => {
    const { baseUrl } = await newServer({ poster: stubPoster() });
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('bearer auth required when configured', async () => {
    const { baseUrl } = await newServer({
      poster: stubPoster(),
      authToken: 's3cret',
    });
    const noAuth = await fetch(`${baseUrl}/status`);
    expect(noAuth.status).toBe(401);
    const ok = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    expect(ok.status).toBe(200);
  });

  it('wrong bearer → 401', async () => {
    const { baseUrl } = await newServer({
      poster: stubPoster(),
      authToken: 's3cret',
    });
    const bad = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(bad.status).toBe(401);
  });
});
