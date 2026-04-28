#!/usr/bin/env node
/**
 * Bundle audit — defends gate G-6 (feature 005).
 *
 * After `next build`, walks `.next/server/**` and asserts no chunk
 * contains evidence that `@electric-sql/pglite` or the `pg` driver
 * snuck back in (forbidden after the demo retired its `bam-store`
 * dependency). A future tree-shake regression that re-includes the
 * substrate now fails this audit instead of silently shipping a
 * 50 MB+ WASM blob.
 *
 * Exit 0 → clean. Exit 1 → at least one forbidden marker found.
 *
 * Usage:
 *   node scripts/audit-bundle.mjs [bundle-root]
 *
 * Defaults `bundle-root` to `.next/server`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? join(__dirname, '..', '.next', 'server');

/**
 * Forbidden substrings. Each entry is a string the substrate's
 * runtime would necessarily include — package name, an import
 * marker, or a header that's load-bearing for resolution.
 */
const FORBIDDEN = [
  '@electric-sql/pglite',
  'postgres.wasm',
  // `pg` is a too-short name to grep raw — match an import / require
  // marker instead so we don't false-positive on words containing "pg".
  "from 'pg'",
  'require("pg")',
  "require('pg')",
];

/**
 * Skip patterns — paths under .next/server we don't audit. Source
 * maps shouldn't carry the substrate either, but the build trace
 * includes our own source paths and we don't want to false-positive
 * on this very file.
 */
const SKIP_PATH_PATTERNS = [/audit-bundle\.mjs$/];

/** Recursively walks `dir`, yielding file paths. */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function main() {
  let rootStat;
  try {
    rootStat = await stat(ROOT);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(
        `[audit-bundle] ${ROOT} does not exist. Run \`pnpm --filter message-in-a-blobble build\` first.`
      );
      process.exit(1);
    }
    throw err;
  }
  if (!rootStat.isDirectory()) {
    console.error(`[audit-bundle] ${ROOT} is not a directory`);
    process.exit(1);
  }

  const violations = [];
  let scanned = 0;
  for await (const path of walk(ROOT)) {
    if (SKIP_PATH_PATTERNS.some((re) => re.test(path))) continue;
    scanned++;
    let body;
    try {
      body = await readFile(path, 'utf8');
    } catch {
      // Binary file or read error — skip rather than treat as a hit.
      continue;
    }
    for (const needle of FORBIDDEN) {
      if (body.includes(needle)) {
        violations.push({ path, needle });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`[audit-bundle] ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`  ${v.path}: contains ${JSON.stringify(v.needle)}`);
    }
    process.exit(1);
  }

  console.log(
    `[audit-bundle] OK — scanned ${scanned} file(s) under ${ROOT}; no forbidden substrate markers found.`
  );
}

main().catch((err) => {
  console.error('[audit-bundle] fatal:', err);
  process.exit(1);
});
