import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POSTER_REJECTIONS } from '../../src/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../../src');

async function allTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await allTsFiles(full)));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Gate G-7 / plan §C-4: every rejection emitted across the library
 * boundary must come from the `PosterRejection` enum. This static
 * check scans the `src/` tree for `reason: '...'` or `reason: "..."`
 * forms — the fields where a PosterRejection value would be
 * returned — and asserts every such occurrence resolves to a value
 * in the enum (which it must by construction when the enum is used,
 * but the assertion protects against typos or drift).
 *
 * Free-form strings in other positions (`HealthState` enum values,
 * JSON keys, logger names) are outside the scope — those don't
 * surface as rejection reasons.
 */
describe('error hygiene — stable rejection codes only (G-7)', () => {
  it('every `reason:` string literal outside errors.ts is a valid PosterRejection value', async () => {
    const files = await allTsFiles(SRC_ROOT);
    const errorsFile = path.resolve(SRC_ROOT, 'errors.ts');
    const typesFile = path.resolve(SRC_ROOT, 'types.ts');
    const violations: Array<{ file: string; literal: string; line: number }> = [];
    const reasonLiteralPattern = /reason\s*:\s*['"`]([^'"`]+)['"`]/g;

    for (const file of files) {
      if (path.resolve(file) === errorsFile) continue;
      // types.ts mentions `reason?: string` at the type level — no runtime literals.
      if (path.resolve(file) === typesFile) continue;
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        reasonLiteralPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = reasonLiteralPattern.exec(line)) !== null) {
          const value = match[1];
          // `BackoffConfig` uses `reason: string` type-only — ignore
          // string-typed signature contexts (those lines don't have
          // quoted string literals, so the regex won't fire).
          // Health reason strings (e.g. 'wallet balance low') are NOT
          // PosterRejection values and are allowed — but we only
          // expect them in surfaces/health.ts, which is a readHealth
          // construction, not a rejection.
          if (value === 'wallet balance low' || value === 'RPC slow') continue; // test fixtures
          if (!(POSTER_REJECTIONS as readonly string[]).includes(value)) {
            violations.push({ file, literal: value, line: i + 1 });
          }
        }
      }
    }

    expect(
      violations,
      `error-hygiene violations (G-7): ${JSON.stringify(violations, null, 2)}`
    ).toEqual([]);
  });
});
