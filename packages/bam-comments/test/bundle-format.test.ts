/**
 * Pins the widget bundle format. The embed contract is a plain
 * classic `<script src="/widget.js" defer>` — no `type="module"`.
 * That requires the bundle to be self-executing IIFE, not ESM:
 * an ESM bundle's `export {…}` at the top level aborts a classic
 * script tag with a SyntaxError, and the widget never mounts.
 *
 * If a future change in `vite.config.ts` flips `formats` back to
 * `['es']` (or otherwise reintroduces top-level imports/exports),
 * this test fails before any embed page goes silently dark.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = path.resolve(here, '..', 'dist', 'widget.js');

describe('widget bundle format', () => {
  let bundle: string;

  beforeAll(() => {
    if (!existsSync(widgetPath)) {
      execSync('pnpm build', { cwd: path.resolve(here, '..'), stdio: 'inherit' });
    }
    bundle = readFileSync(widgetPath, 'utf-8');
  });

  it('emits an IIFE assigned to the documented global name', () => {
    // Vite's IIFE template: `var BamComments = (function(exports) {…})({});`
    expect(bundle).toMatch(/^var BamComments\s*=\s*function/);
  });

  it('does not contain top-level `export` (ESM marker)', () => {
    // Strip the trailing sourcemap comment + any whitespace, then
    // assert the executable doesn't end with an `export {…}` block
    // (the smoking-gun signal of an ESM bundle, which a classic
    // script tag cannot load).
    const code = bundle.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd();
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
