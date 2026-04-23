import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
  POSTER_REJECTIONS,
} from '../../src/index.js';
import { HttpServer } from '../../src/http/server.js';
import { rejectionToStatus } from '../../src/http/error-map.js';
import type { BuildAndSubmit, PosterFactoryExtras } from '../../src/index.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

const buildAndSubmit: BuildAndSubmit = async () => ({
  kind: 'included',
  txHash: ('0x' + '11'.repeat(32)) as Bytes32,
  blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
  blockNumber: 100,
});

function rpcOk(): PosterFactoryExtras['rpc'] {
  return {
    async getChainId() {
      return 1;
    },
    async getCode() {
      return '0x6080' as `0x${string}`;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async getBlockNumber() {
      return 100n;
    },
    async getTransactionBlock() {
      return 100;
    },
  };
}

async function signedEnvelope(nonce: number, content: string, privateKey?: `0x${string}`) {
  const pk = (privateKey ?? generateECDSAPrivateKey()) as `0x${string}`;
  const author = privateKeyToAccount(pk).address as Address;
  const timestamp = 1_700_000_000;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  return {
    pk,
    bytes: Buffer.from(
      JSON.stringify({
        contentTag: TAG,
        message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
      })
    ),
  };
}

interface Harness {
  server: HttpServer;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(
  maxBytes = 120_000,
  authToken?: string
): Promise<Harness> {
  _clearSignerRegistryForTests();
  const pk = generateECDSAPrivateKey() as `0x${string}`;
  const signer = new LocalEcdsaSigner(pk);
  const poster = await createPoster(
    {
      allowlistedTags: [TAG],
      chainId: 1,
      bamCoreAddress: BAM_CORE,
      signer,
      store: createMemoryStore(),
      maxMessageSizeBytes: maxBytes,
    },
    { buildAndSubmit, rpc: rpcOk() }
  );
  const server = new HttpServer({ poster, maxMessageSizeBytes: maxBytes, authToken });
  await server.listen(0);
  const addr = server.address();
  if (!addr) throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    baseUrl,
    close: async () => {
      await server.close();
      await poster.stop();
    },
  };
}

describe('HTTP transport — every endpoint', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('POST /submit returns 201 on success and { accepted, messageId }', async () => {
    const { bytes } = await signedEnvelope(1, 'hi');
    const res = await fetch(`${h.baseUrl}/submit`, {
      method: 'POST',
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accepted: boolean; messageId: string };
    expect(body.accepted).toBe(true);
    expect(body.messageId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('GET /pending returns the pool', async () => {
    const { bytes } = await signedEnvelope(1, 'hello');
    await fetch(`${h.baseUrl}/submit`, { method: 'POST', body: new Uint8Array(bytes) });
    const res = await fetch(`${h.baseUrl}/pending?contentTag=${TAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: unknown[] };
    expect(body.pending).toHaveLength(1);
  });

  it('GET /status + GET /health return distinct JSON shapes', async () => {
    const status = await (await fetch(`${h.baseUrl}/status`)).json();
    const health = await (await fetch(`${h.baseUrl}/health`)).json();
    const statusKeys = Object.keys((status as { status: Record<string, unknown> }).status);
    const healthKeys = Object.keys((health as { health: Record<string, unknown> }).health);
    expect(new Set(statusKeys).has('state')).toBe(false);
    expect(new Set(healthKeys).has('walletAddress')).toBe(false);
  });

  it('GET /submitted-batches returns [] before any submission', async () => {
    const res = await fetch(`${h.baseUrl}/submitted-batches?contentTag=${TAG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batches: unknown[] };
    expect(body.batches).toEqual([]);
  });

  it('POST /flush requires contentTag; returns 400 on missing', async () => {
    const res = await fetch(`${h.baseUrl}/flush`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('returns 404 on unknown paths with a stable body', async () => {
    const res = await fetch(`${h.baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('HTTP transport — oversized body', () => {
  it('rejects bodies exceeding maxMessageSizeBytes with 413', async () => {
    const h = await startHarness(100);
    try {
      const big = new Uint8Array(200);
      const res = await fetch(`${h.baseUrl}/submit`, { method: 'POST', body: big });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe('message_too_large');
    } finally {
      await h.close();
    }
  });

  it('severs the socket before the full body is uploaded (FU-4)', async () => {
    const http = await import('node:http');
    const h = await startHarness(100);
    try {
      const port = h.server.address()!.port;
      const bytesSent = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/submit',
            // Advertise a body much larger than the cap.
            headers: { 'Content-Length': '10000000' },
          },
          (res) => {
            expect(res.statusCode).toBe(413);
            res.resume();
          }
        );
        let sent = 0;
        let aborted = false;
        req.on('error', () => {
          // Server-severed sockets surface as ECONNRESET on write;
          // that's the expected healthy outcome here.
          if (aborted) return;
          aborted = true;
          resolve(sent);
        });
        req.on('close', () => {
          if (aborted) return;
          aborted = true;
          resolve(sent);
        });
        // Slowly stream chunks; once ~200 bytes are sent the server
        // should have responded + closed the socket, and write() will
        // fail before we push the full 10 MB.
        const chunk = Buffer.alloc(50, 0x61);
        let writable = true;
        const pump = (): void => {
          if (!writable || aborted) return;
          for (let i = 0; i < 10 && writable && !aborted; i++) {
            writable = req.write(chunk, (err) => {
              if (err) {
                // write errored — socket is severed
                if (!aborted) {
                  aborted = true;
                  resolve(sent);
                }
              }
            });
            sent += chunk.length;
          }
          if (!aborted) setTimeout(pump, 5);
        };
        pump();
        // Safety net: if for some reason it drains fully, end after 500 ms.
        setTimeout(() => {
          if (!aborted) {
            try { req.end(); } catch { /* ignore */ }
          }
        }, 500);
        req.on('socket', (sock) => {
          sock.on('close', () => {
            if (aborted) return;
            aborted = true;
            resolve(sent);
          });
        });
        setTimeout(() => {
          if (!aborted) reject(new Error('server didn\'t abort'));
        }, 2000);
      });

      // The important invariant: we did NOT upload the full 10 MB.
      expect(bytesSent).toBeLessThan(10_000_000);
    } finally {
      await h.close();
    }
  });
});

describe('HTTP transport — error-code mapping covers every rejection', () => {
  it('maps every PosterRejection to a stable HTTP status', () => {
    for (const reason of POSTER_REJECTIONS) {
      const s = rejectionToStatus(reason);
      expect([400, 413, 429, 500, 503]).toContain(s);
    }
  });

  it('content_tag_mismatch via ?contentTag hint → 400', async () => {
    const h = await startHarness();
    try {
      const { bytes } = await signedEnvelope(1, 'hi');
      const res = await fetch(
        `${h.baseUrl}/submit?contentTag=0x${'bb'.repeat(32)}`,
        { method: 'POST', body: new Uint8Array(bytes) }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe('content_tag_mismatch');
    } finally {
      await h.close();
    }
  });
});

describe('HTTP transport — bearer-token auth (FU-12)', () => {
  it('rejects every endpoint with 401 when no token is provided', async () => {
    const h = await startHarness(120_000, 'secret-xyz');
    try {
      const endpoints: Array<[string, string]> = [
        ['POST', '/submit'],
        ['GET', '/pending'],
        ['GET', '/submitted-batches'],
        ['GET', '/status'],
        ['GET', '/health'],
        [
          'POST',
          `/flush?contentTag=0x${'aa'.repeat(32)}`,
        ],
      ];
      for (const [method, path] of endpoints) {
        const res = await fetch(`${h.baseUrl}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('unauthorized');
        expect(res.headers.get('www-authenticate')).toContain('Bearer');
      }
    } finally {
      await h.close();
    }
  });

  it('rejects with 401 on wrong token', async () => {
    const h = await startHarness(120_000, 'secret-xyz');
    try {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('rejects with 401 on the wrong scheme (e.g. Basic)', async () => {
    const h = await startHarness(120_000, 'secret-xyz');
    try {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: { Authorization: 'Basic c2VjcmV0LXh5eg==' },
      });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('accepts requests carrying the correct bearer token', async () => {
    const h = await startHarness(120_000, 'secret-xyz');
    try {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: { Authorization: 'Bearer secret-xyz' },
      });
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('is open when no authToken is configured (default)', async () => {
    const h = await startHarness(120_000);
    try {
      const res = await fetch(`${h.baseUrl}/status`);
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('HTTP transport — query validation (cubic review)', () => {
  it('rejects a malformed sinceBlock with 400 instead of 500', async () => {
    const h = await startHarness();
    try {
      const res = await fetch(
        `${h.baseUrl}/submitted-batches?sinceBlock=abc`
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; field: string };
      expect(body.error).toBe('invalid_query');
      expect(body.field).toBe('sinceBlock');
    } finally {
      await h.close();
    }
  });

  it('rejects a malformed limit with 400', async () => {
    const h = await startHarness();
    try {
      const res = await fetch(`${h.baseUrl}/submitted-batches?limit=abc`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; field: string };
      expect(body.field).toBe('limit');
    } finally {
      await h.close();
    }
  });

  it('rejects a malformed limit on /pending with 400 (cubic review)', async () => {
    // Pre-fix, /pending accepted arbitrary limit strings — `?limit=abc`
    // flowed NaN into the store. Now parsing mirrors submittedHandler.
    const h = await startHarness();
    try {
      for (const bad of ['abc', '-1', '3.5']) {
        const res = await fetch(`${h.baseUrl}/pending?limit=${bad}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; field: string };
        expect(body.error).toBe('invalid_query');
        expect(body.field).toBe('limit');
      }
      const ok = await fetch(`${h.baseUrl}/pending?limit=10`);
      expect(ok.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('accepts a well-formed sinceBlock', async () => {
    const h = await startHarness();
    try {
      const res = await fetch(`${h.baseUrl}/submitted-batches?sinceBlock=100`);
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
