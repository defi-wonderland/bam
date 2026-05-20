/**
 * Browser-bundle audit for the `bam-sdk/post-reply` subpath. The
 * subpath is a protocol contract between FE encoders (browser) and
 * indexer decoders (Node), so its transitive static-import closure
 * must stay free of Node-only modules (`c-kzg`, `pg`, `node:*`, etc.)
 * even though the package's main entry legitimately pulls them.
 *
 * The walker follows relative imports inside `src/` from
 * `src/post-reply/index.ts` and flags any external specifier that
 * matches the forbidden set.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/post-reply/index.ts');

const FORBIDDEN: RegExp[] = [
  /^node:/,
  /^pg$/,
  /^c-kzg$/,
  /^better-sqlite3$/,
  /^@libsql\/client$/,
  /^@electric-sql\/pglite/,
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
    for (const imp of readSourceImports(f)) {
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

describe('bam-sdk/post-reply browser-bundle audit', () => {
  it('transitive imports are browser-safe', () => {
    const { externals } = transitiveClosure(ENTRY);
    const violations = [...externals].filter((spec) =>
      FORBIDDEN.some((re) => re.test(spec)),
    );
    expect(
      violations,
      `post-reply transitively imports forbidden modules: ${violations.join(', ')}`,
    ).toEqual([]);
  });
});
