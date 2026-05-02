/**
 * Verifies the post fixture set matches the manifest in
 * `posts/_slugs.ts`:
 *
 *   - exactly 5 entries,
 *   - unique slugs,
 *   - every declared slug has a matching `posts/<slug>.html`,
 *   - every post HTML carries the `data-post-slug="<slug>"` mount and
 *     the `<script type="module" src="/comments.js">` tag.
 *
 * `posts/index.html` exists and lists every slug as well.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { POSTS } from '../src/posts.js';

const POSTS_DIR = resolve(__dirname, '..');

describe('post fixtures', () => {
  it('declares exactly 5 posts', () => {
    expect(POSTS).toHaveLength(5);
  });

  it('has unique slugs', () => {
    const slugs = POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses lowercase-slug-with-hyphens for every slug', () => {
    for (const { slug } of POSTS) {
      expect(slug, `slug ${slug}`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('has a posts/<slug>.html for every declared slug', () => {
    for (const { slug } of POSTS) {
      const path = resolve(POSTS_DIR, `${slug}.html`);
      expect(existsSync(path), `missing ${path}`).toBe(true);
    }
  });

  it('every post HTML contains the embed mount marker', () => {
    for (const { slug } of POSTS) {
      const html = readFileSync(resolve(POSTS_DIR, `${slug}.html`), 'utf8');
      expect(
        /data-bam-comments\b/.test(html),
        `post ${slug} is missing data-bam-comments`
      ).toBe(true);
      expect(
        html.includes(`data-post-id="${slug}"`),
        `post ${slug} is missing data-post-id="${slug}"`
      ).toBe(true);
    }
  });

  it('every post HTML loads /widget.js (the stable embed URL)', () => {
    for (const { slug } of POSTS) {
      const html = readFileSync(resolve(POSTS_DIR, `${slug}.html`), 'utf8');
      // External embedders use this same script tag; in dev a Vite
      // middleware aliases /widget.js to the source entry, in build
      // it resolves to the lib-mode bundle.
      expect(
        /<script\s+src=["']\/widget\.js["']\s+defer\s*>/.test(html),
        `post ${slug} is missing <script src="/widget.js" defer>`
      ).toBe(true);
    }
  });

  it('every post HTML has a <noscript> fallback for the comments area', () => {
    for (const { slug } of POSTS) {
      const html = readFileSync(resolve(POSTS_DIR, `${slug}.html`), 'utf8');
      expect(
        /<noscript>/i.test(html),
        `post ${slug} is missing a <noscript> fallback`
      ).toBe(true);
    }
  });

  it('posts/index.html exists and links every declared slug', () => {
    const indexPath = resolve(POSTS_DIR, 'index.html');
    expect(existsSync(indexPath)).toBe(true);
    const html = readFileSync(indexPath, 'utf8');
    for (const { slug } of POSTS) {
      expect(
        html.includes(`/${slug}.html`),
        `index.html does not link to /${slug}.html`
      ).toBe(true);
    }
  });
});
