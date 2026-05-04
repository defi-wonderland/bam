/**
 * Pin the public embed contract: every HTML page in the demo carries
 * a `[data-bam-comments]` mount with a non-empty `data-post-id`, and
 * loads the widget through `<script src="/widget.js" defer>`. If a
 * page drifts away from this shape, the widget snippet docs in the
 * package README go stale silently — this test fails first.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoRoot = path.resolve(here, '..');

const pages = readdirSync(demoRoot).filter((f) => f.endsWith('.html'));

describe('embed snippet', () => {
  it('finds at least one HTML page', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    describe(page, () => {
      const html = readFileSync(path.join(demoRoot, page), 'utf-8');

      it('mounts a [data-bam-comments] element', () => {
        expect(html).toMatch(/data-bam-comments\b/);
      });

      it('declares a non-empty data-post-id', () => {
        const match = html.match(/data-post-id="([^"]*)"/);
        expect(match).not.toBeNull();
        expect(match![1].length).toBeGreaterThan(0);
      });

      it('declares the bam-comments-demo site id', () => {
        expect(html).toMatch(/data-site-id="bam-comments-demo"/);
      });

      it('loads /widget.js with defer', () => {
        expect(html).toMatch(/<script\s+src="\/widget\.js"\s+defer\s*>/);
      });
    });
  }
});
