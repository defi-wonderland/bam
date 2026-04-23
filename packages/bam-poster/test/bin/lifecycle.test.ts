import { describe, it, expect, afterEach } from 'vitest';

import { runCli } from '../../src/bin/bam-poster.js';

describe('bam-poster CLI — env validation lifecycle', () => {
  const origExit = process.exit;
  const origStderr = process.stderr.write;
  let exited: number | null = null;
  let stderrBuf = '';

  function installStubs(): void {
    exited = null;
    stderrBuf = '';
    process.exit = ((code?: number) => {
      exited = code ?? 0;
      throw new Error(`__test_exit_${exited}`);
    }) as (code?: number) => never;
    process.stderr.write = ((chunk: unknown) => {
      stderrBuf += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
  }

  function restoreStubs(): void {
    process.exit = origExit;
    process.stderr.write = origStderr;
  }

  afterEach(() => restoreStubs());

  function withEnv(env: Record<string, string | undefined>): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return () => {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  }

  it('exits with code 2 when POSTER_SIGNER_PRIVATE_KEY is missing', async () => {
    const restoreEnv = withEnv({
      POSTER_ALLOWED_TAGS: '0x' + 'aa'.repeat(32),
      POSTER_CHAIN_ID: '1',
      POSTER_BAM_CORE_ADDRESS: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314',
      POSTER_RPC_URL: 'http://127.0.0.1:1',
      POSTER_SIGNER_PRIVATE_KEY: undefined,
    });
    installStubs();
    try {
      await runCli();
    } catch (err) {
      expect((err as Error).message).toBe('__test_exit_2');
    }
    restoreEnv();
    expect(exited).toBe(2);
    expect(stderrBuf).toMatch(/POSTER_SIGNER_PRIVATE_KEY/);
  });

  it('exits with code 2 when POSTER_ALLOWED_TAGS is empty', async () => {
    const restoreEnv = withEnv({
      POSTER_ALLOWED_TAGS: '',
      POSTER_CHAIN_ID: '1',
      POSTER_BAM_CORE_ADDRESS: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314',
      POSTER_RPC_URL: 'http://127.0.0.1:1',
      POSTER_SIGNER_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
    });
    installStubs();
    try {
      await runCli();
    } catch (err) {
      expect((err as Error).message).toBe('__test_exit_2');
    }
    restoreEnv();
    expect(exited).toBe(2);
    expect(stderrBuf).toMatch(/POSTER_ALLOWED_TAGS/);
  });
});
