/**
 * Pins the widget bundle format. The embed contract is a plain
 * classic `<script src="/widget.js" defer>` — no `type="module"`.
 * That requires the bundle to be self-executing IIFE, not ESM:
 * an ESM bundle's `export {…}` at the top level aborts a classic
 * script tag with a SyntaxError, and the widget never mounts.
 *
 * Two properties have to hold for the embed to actually work, and
 * a regression in either one would silently break every embed:
 *
 *   1. The bundle is structured as a function-expression
 *      assignment (so it parses under a classic script tag).
 *   2. That function is **invoked** at the end (so the top-level
 *      `bootstrap()` side effect actually runs and the widget
 *      auto-mounts). A non-invoked function expression would
 *      satisfy (1) on its own but never execute.
 *
 * If a future change in `vite.config.ts` flips `formats` back to
 * `['es']` (or otherwise reintroduces top-level imports/exports),
 * this test fails before any embed page goes silently dark.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = path.resolve(here, '..', 'dist', 'widget.js');
const packageRoot = path.resolve(here, '..');

describe('widget bundle format', () => {
  let bundle: string;
  /** Bundle without the trailing sourcemap comment + whitespace —
   *  the actual executable JS the browser parses. */
  let code: string;

  beforeAll(async () => {
    // Always rebuild rather than only-when-missing. A leftover
    // `dist/widget.js` from a prior config (e.g. when `formats`
    // was still `'es'`) would otherwise let the test validate the
    // wrong artifact and pass against a bundle the current source
    // wouldn't actually emit.
    //
    // Call Vite's JS API directly rather than spawning a `pnpm`
    // subprocess — under `pnpm test` that would nest pnpm inside
    // pnpm (workspace re-evaluation, lockfile contention, double-
    // run hooks) for no benefit; this test only needs whatever
    // bundle the current `vite.config.ts` would emit.
    await build({
      root: packageRoot,
      logLevel: 'silent',
    });
    bundle = readFileSync(widgetPath, 'utf-8');
    code = bundle.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd();
  }, 30_000);

  it('emits an IIFE assigned to the documented global name', () => {
    // Vite's current IIFE template emits
    //   `var BamComments=function(exports){…}({});`
    // (no whitespace around `=`, no wrapping `(` before `function`).
    // We allow the optional wrapping paren so a future Vite version
    // that switches to the more conventional
    // `var BamComments = (function() {…})()` form still matches.
    expect(bundle).toMatch(/^var BamComments\s*=\s*\(?\s*function/);
  });

  it('actually invokes the IIFE (top-level bootstrap must run)', () => {
    // Without an invocation the function expression is just
    // assigned to `BamComments` and never executes — the embed's
    // `bootstrap()` side effect would be skipped and the widget
    // would silently never auto-mount. Pin the trailing `(...)`
    // call form. Tolerant of both `}(args);` (Vite's current
    // shape) and `})(args);` (conventional wrapped form).
    expect(code).toMatch(/\}\s*\)?\s*\([^;]*\)\s*;?\s*$/);
  });

  it('does not contain top-level `export` (ESM marker)', () => {
    // The smoking-gun signal of an ESM bundle, which a classic
    // script tag cannot load.
    expect(code).not.toMatch(/\bexport\s*\{/);
  });

  it('does not contain top-level `import` statements', () => {
    // Top-level `import` lines are only legal in ESM. The Vite
    // IIFE bundle inlines all dependencies, so there should be
    // none. (Substring `import` may still appear inside string
    // literals — we anchor on the start-of-line statement form.)
    expect(bundle).not.toMatch(/^\s*import\s/m);
  });
});

