/**
 * Unit tests for `scripts/audit-bundle.mjs` — exercises the script as
 * a child process against synthetic fixtures so we don't depend on
 * the actual `next build` output. The real audit run (over
 * `.next/server`) is wired into `pnpm test:bundle-audit` and is the
 * end-to-end check; this test guards the regex/string-matching
 * surface so a refactor doesn't silently weaken it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/audit-bundle.mjs', import.meta.url)
);

function runAudit(target: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [SCRIPT, target], { encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('audit-bundle.mjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-bundle-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when nothing under the bundle root mentions a forbidden marker', () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(
      join(dir, 'chunks', 'app.js'),
      "module.exports = require('next/server');\n"
    );
    const r = runAudit(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('exits 1 when a chunk includes @electric-sql/pglite', () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(
      join(dir, 'chunks', 'rogue.js'),
      "var _ = require('@electric-sql/pglite');\n"
    );
    const r = runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('@electric-sql/pglite');
  });

  it('exits 1 when a chunk references postgres.wasm', () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(
      join(dir, 'chunks', 'wasm-loader.js'),
      "fetch(new URL('postgres.wasm', import.meta.url));\n"
    );
    const r = runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('postgres.wasm');
  });

  it("exits 1 on a `from 'pg'` import marker", () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(
      join(dir, 'chunks', 'rogue.js'),
      "import { Client } from 'pg';\n"
    );
    const r = runAudit(dir);
    expect(r.code).toBe(1);
  });

  it('does not false-positive on benign strings containing pg', () => {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(
      join(dir, 'chunks', 'benign.js'),
      "var openpgp = 'cryptographic library name';\nvar bigPGroup = 1;\n"
    );
    const r = runAudit(dir);
    expect(r.code).toBe(0);
  });
});
