/**
 * Browser-bundle audit: assert that the transitive closure of source
 * files reachable from `bam-store/browser` does not statically import
 * any forbidden module. The forbidden set covers `pg`,
 * `drizzle-orm/node-postgres`, `node:*`, the SQLite adapters that have
 * been retired (`better-sqlite3`, `@libsql/client`), and the
 * Node-specific PGLite entrypoint (`@electric-sql/pglite/node`). The
 * universal `@electric-sql/pglite` entrypoint is allowed — its package
 * exports map resolves to the right build per environment.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

const FORBIDDEN = [
  /^pg$/,
  /^drizzle-orm\/node-postgres$/,
  /^@electric-sql\/pglite\/node$/,
  /^better-sqlite3$/,
  /^@libsql\/client$/,
  /^node:/,
];

function readSourceImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  // Match static `import ... from '...'` / `import '...'` / `export ... from '...'`.
  const statics =
    /(?:^|[\s;])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = statics.exec(text))) out.push(m[1]);
  // Match dynamic `import('...')`.
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(text))) out.push(m[1]);
  return out;
}

function resolveLocal(spec: string, fromDir: string): string | null {
  if (!spec.startsWith('.')) return null;
  // Strip extension; we resolve `.ts` next to the importer, then
  // fall back to `<spec>/index.ts`.
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

describe('bam-store browser bundle audit', () => {
  it('the transitive closure of browser.ts has no forbidden imports', () => {
    const entry = resolve(SRC, 'browser.ts');
    const { externals } = transitiveClosure(entry);
    const violations = [...externals].filter((spec) =>
      FORBIDDEN.some((re) => re.test(spec))
    );
    expect(
      violations,
      `browser.ts transitively imports forbidden modules: ${violations.join(', ')}`
    ).toEqual([]);
  });

  it('the allowed-set sanity check: the universal pglite entrypoint is reachable', () => {
    const entry = resolve(SRC, 'browser.ts');
    const { externals } = transitiveClosure(entry);
    expect(externals.has('@electric-sql/pglite')).toBe(true);
  });
});
