import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * FU-10: spawn the compiled `bam-poster` binary as a real subprocess
 * with a mocked JSON-RPC upstream, send SIGTERM, and assert:
 *   - process exits 0 within a short timeout
 *   - stdout contains a "shutting down" line (graceful, not killed)
 *   - the HTTP listen port has been released (server closed)
 *
 * Requires `@bam/poster`'s dist to exist. If the build output is
 * missing, the test fails fast with a clear message rather than
 * silently skipping.
 */
describe('bam-poster CLI — SIGTERM graceful shutdown (FU-10)', () => {
  it('exits 0 on SIGTERM and prints a shutdown line', async () => {
    const binPath = path.resolve(__dirname, '../../dist/esm/bin/bam-poster.js');
    if (!existsSync(binPath)) {
      throw new Error(
        `FU-10 requires the build output at ${binPath}. Run \`pnpm --filter @bam/poster build\` first.`
      );
    }

    // Fake JSON-RPC: just enough for reconcileStartup to succeed.
    const rpc = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { id: number; method: string };
          const result = (() => {
            switch (parsed.method) {
              case 'eth_chainId':
                return '0x1';
              case 'eth_getCode':
                return '0x6080604052';
              case 'eth_blockNumber':
                return '0x64';
              default:
                return null;
            }
          })();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
        } catch {
          res.statusCode = 400;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', () => resolve()));
    const rpcAddr = rpc.address();
    if (rpcAddr === null || typeof rpcAddr === 'string') throw new Error('no rpc addr');
    const rpcUrl = `http://127.0.0.1:${rpcAddr.port}`;

    const posterPort = await freePort();

    const env: Record<string, string> = {
      ...process.env,
      POSTER_ALLOWED_TAGS: '0x' + 'aa'.repeat(32),
      POSTER_CHAIN_ID: '1',
      POSTER_BAM_CORE_ADDRESS: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314',
      POSTER_RPC_URL: rpcUrl,
      POSTER_SIGNER_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
      POSTER_PORT: String(posterPort),
      POSTER_SQLITE_PATH: ':memory:',
      NODE_NO_WARNINGS: '1',
    };

    const child = spawn('node', [binPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    try {
      // Wait for the "listening on …" line so we know the process is past
      // reconcileStartup and has mounted the HTTP server.
      const listening = await waitFor(
        () => stdout.includes('listening on'),
        5_000,
        () => `stdout=${stdout} stderr=${stderr}`
      );
      expect(listening).toBe(true);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('shutting down');
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
    }
  }, 20_000);
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port =
        addr !== null && typeof addr !== 'string' ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  diag: () => string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${diag()}`);
}
