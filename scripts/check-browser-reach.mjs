#!/usr/bin/env node
/**
 * Browser-reachability gate (feature 001-bam-poster, gate G-5).
 *
 * Asserts that no module under `packages/bam-poster/` is reachable from
 * any package's `"browser"` entry, or from `bam-sdk/browser` directly.
 * Principle II in the repo's constitution says the SDK is dual-runtime
 * (Node + browser); the Poster is Node-only. A silent import from a
 * browser-reachable path would break that invariant.
 *
 * The check is deliberately simple: static text-scan of every package
 * that declares a `"browser"` field (or that re-exports a `/browser`
 * subpath), plus a regex scan of the resolved entrypoint's imports
 * for any reference to `@bam/poster` / `packages/bam-poster`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const POSTER_PACKAGE_NAMES = new Set(['@bam/poster']);
const POSTER_DIR = path.resolve(REPO_ROOT, 'packages/bam-poster');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walkSource(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  try {
    const src = await readFile(file, 'utf8');
    const importRegex = /(?:import[^'"]*?from\s*|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;
    let match;
    const refs = new Set();
    while ((match = importRegex.exec(src)) !== null) refs.add(match[1]);
    for (const ref of refs) {
      if (ref.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), ref);
        for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']) {
          const candidate = resolved + suffix;
          if (await exists(candidate)) {
            await walkSource(candidate, seen);
            break;
          }
        }
      }
    }
  } catch {
    // ignore unreadable
  }
  return seen;
}

async function collectBrowserEntries() {
  const entries = [];
  const packages = [
    path.join(REPO_ROOT, 'packages'),
    path.join(REPO_ROOT, 'apps'),
  ];
  for (const dir of packages) {
    if (!(await exists(dir))) continue;
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const pkgPath = path.join(dir, child.name, 'package.json');
      if (!(await exists(pkgPath))) continue;
      const pkg = await readJson(pkgPath);
      if (pkg.browser) {
        entries.push({
          pkgDir: path.dirname(pkgPath),
          name: pkg.name,
          browser: pkg.browser,
        });
      }
      // bam-sdk exposes a `./browser` subpath via `exports`.
      if (pkg.name === 'bam-sdk' && pkg.exports && pkg.exports['./browser']) {
        entries.push({
          pkgDir: path.dirname(pkgPath),
          name: pkg.name,
          browser: 'src/browser.ts',
        });
      }
    }
  }
  return entries;
}

function referencesPoster(src) {
  const patterns = [
    /@bam\/poster/,
    /packages\/bam-poster/,
    /['"](\.\.\/)+bam-poster/,
  ];
  return patterns.some((p) => p.test(src));
}

async function main() {
  const entries = await collectBrowserEntries();
  const failures = [];

  for (const entry of entries) {
    let entrySource;
    if (typeof entry.browser === 'string') {
      entrySource = path.resolve(entry.pkgDir, entry.browser);
    } else if (typeof entry.browser === 'object') {
      entrySource = path.resolve(entry.pkgDir, Object.values(entry.browser)[0]);
    } else {
      continue;
    }
    // The resolved entry may be a dist artifact — prefer src where
    // available (we're running on a source tree).
    const maybeSrc = entrySource
      .replace(/\/dist\/esm\//, '/src/')
      .replace(/\/dist\/types\//, '/src/')
      .replace(/\.js$/, '.ts');
    const pickedEntry = (await exists(maybeSrc)) ? maybeSrc : entrySource;

    if (!(await exists(pickedEntry))) continue;

    const reachable = await walkSource(pickedEntry);
    for (const file of reachable) {
      if (file.startsWith(POSTER_DIR)) {
        failures.push({ browserEntry: pickedEntry, reachesPoster: file });
        break;
      }
      const src = await readFile(file, 'utf8');
      if (referencesPoster(src)) {
        failures.push({ browserEntry: pickedEntry, referenceInSource: file });
        break;
      }
    }
  }

  // Also sanity-check: poster's own package.json must NOT declare a "browser" field.
  const posterPkg = await readJson(path.join(POSTER_DIR, 'package.json'));
  if (posterPkg.browser !== undefined) {
    failures.push({
      note: 'packages/bam-poster/package.json declares a "browser" field',
      value: posterPkg.browser,
    });
  }
  // Nothing in the poster exports map should target `/browser`.
  if (posterPkg.exports && posterPkg.exports['./browser']) {
    failures.push({
      note: 'packages/bam-poster/package.json declares `./browser` in exports',
    });
  }

  if (failures.length > 0) {
    console.error('browser-reachability gate (G-5) FAILED:');
    for (const f of failures) console.error(JSON.stringify(f, null, 2));
    process.exit(1);
  }
  console.log(
    `browser-reachability gate (G-5) OK — ${POSTER_PACKAGE_NAMES.size} poster package(s), ${entries.length} browser entry point(s) scanned.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
