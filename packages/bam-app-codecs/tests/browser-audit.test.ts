/**
 * Browser-bundle audit: the package is the protocol contract between
 * FE encoders (browser) and indexer decoders (Node). Every codec
 * subdirectory MUST be browser-safe — bytes in, bytes out, no Node
 * built-ins, no `c-kzg`, no `pg`, no `bam-sdk` main entry (which pulls
 * `c-kzg` transitively).
 *
 * The audit walks the transitive static-import closure of every
 * `src/<subdir>/index.ts` and asserts no import matches the
 * forbidden set. Pattern copied from
 * `packages/bam-store/tests/browser-audit.test.ts` — same regex
 * walker, different forbidden list.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

const FORBIDDEN: RegExp[] = [
  /^node:/,
  /^pg$/,
  /^c-kzg$/,
  /^better-sqlite3$/,
  /^@libsql\/client$/,
  /^@electric-sql\/pglite/,
  // Main bam-sdk entry transitively imports c-kzg. Codecs must use
  // `bam-sdk/browser` only.
  /^bam-sdk$/,
];

function readSourceImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const statics =
    /(?:^|[\s;])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = statics.exec(text))) out.push(m[1]);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(text))) out.push(m[1]);
  return out;
}

function resolveLocal(spec: string, fromDir: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(fromDir, spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function transitiveClosure(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift()!;
    if (files.has(f)) continue;
    files.add(f);
    const imports = readSourceImports(f);
    for (const imp of imports) {
      const local = resolveLocal(imp, dirname(f));
      if (local) {
        if (!files.has(local)) queue.push(local);
      } else {
        externals.add(imp);
      }
    }
  }
  return { files, externals };
}

function codecEntries(): string[] {
  // Each immediate subdirectory of `src/` is treated as one codec;
  // its `index.ts` is the entry the browser will import via the
  // package's `./<subdir>` subpath export.
  const entries: string[] = [];
  for (const name of readdirSync(SRC)) {
    const full = resolve(SRC, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const entry = resolve(full, 'index.ts');
    try {
      readFileSync(entry, 'utf8');
      entries.push(entry);
    } catch {
      // subdir without index.ts — ignore
    }
  }
  return entries;
}

describe('bam-app-codecs browser-bundle audit', () => {
  const entries = codecEntries();

  it('at least one codec entry is present', () => {
    // Sanity — the package would be empty otherwise, and a passing
    // audit would lie about an invariant that has no real subject.
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    const rel = entry.slice(SRC.length + 1);
    it(`${rel}: transitive imports are browser-safe`, () => {
      const { externals } = transitiveClosure(entry);
      const violations = [...externals].filter((spec) =>
        FORBIDDEN.some((re) => re.test(spec))
      );
      expect(
        violations,
        `${rel} transitively imports forbidden modules: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it(`${rel}: bam-sdk imports use the /browser subpath`, () => {
      const { externals } = transitiveClosure(entry);
      const bare = [...externals].filter((s) => s === 'bam-sdk');
      expect(
        bare,
        `${rel} imports bare 'bam-sdk' (use 'bam-sdk/browser' instead)`
      ).toEqual([]);
    });
  }
});
