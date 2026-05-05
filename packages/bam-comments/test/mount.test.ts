/**
 * Pins the two reliability properties Qodo flagged on PR #44:
 *
 * 1. `mountInstance` must not mark a node `__bamMounted` until it
 *    has cleared every synchronous validation step that can throw
 *    (`resolveSiteId`, `derivePostIdHash`). Otherwise a single bad
 *    config wedges the node permanently, with no path to retry.
 *
 * 2. `mountInstance` must surface a stable error into the node when
 *    init throws, instead of letting the exception escape — the
 *    auto-mount loop iterates with `forEach`, so an uncaught throw
 *    on one node would skip every later node on the page.
 */

import { describe, it, expect } from 'vitest';

import { mountInstance } from '../src/render.js';

const FLAG_KEY = '__bamMounted' as const;

interface FlaggedElement extends HTMLElement {
  [FLAG_KEY]?: boolean;
}

function makeMount(attrs: Record<string, string | null>): FlaggedElement {
  const el = document.createElement('div') as FlaggedElement;
  el.setAttribute('data-bam-comments', '');
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null) el.setAttribute(k, v);
  }
  return el;
}

describe('mountInstance — failure containment', () => {
  it('does not set __bamMounted when data-post-id is missing', () => {
    const el = makeMount({ 'data-site-id': 'demo.example' });
    mountInstance(el);
    expect(el[FLAG_KEY]).not.toBe(true);
    expect(el.textContent).toContain('data-post-id missing');
  });

  it('does not set __bamMounted when data-post-id is empty', () => {
    const el = makeMount({
      'data-post-id': '',
      'data-site-id': 'demo.example',
    });
    mountInstance(el);
    expect(el[FLAG_KEY]).not.toBe(true);
  });

  it('does not throw when resolveSiteId would throw', () => {
    // No data-site-id and no hostname (happy-dom defaults to
    // "localhost" but we override) → resolveSiteId throws inside
    // mountInstance. The widget must catch and render a stable
    // message; the throw must NOT escape to the caller.
    const el = makeMount({ 'data-post-id': 'p' });
    const original = window.location.hostname;
    Object.defineProperty(window.location, 'hostname', {
      configurable: true,
      value: '',
    });
    try {
      expect(() => mountInstance(el)).not.toThrow();
      expect(el[FLAG_KEY]).not.toBe(true);
      expect(el.textContent).toMatch(/bam-comments:/);
    } finally {
      Object.defineProperty(window.location, 'hostname', {
        configurable: true,
        value: original,
      });
    }
  });

  it('a remount after a failed init can succeed (flag is not stuck)', () => {
    const el = makeMount({ 'data-site-id': 'demo.example' }); // missing post-id
    mountInstance(el);
    expect(el[FLAG_KEY]).not.toBe(true);

    // Operator-side fix: set the missing attribute and try again.
    el.setAttribute('data-post-id', 'fixed');
    const destroy = mountInstance(el);
    expect(el[FLAG_KEY]).toBe(true);
    destroy();
    expect(el[FLAG_KEY]).toBe(false);
  });

  it('refuses to double-mount the same node (idempotent)', () => {
    const el = makeMount({
      'data-post-id': 'p',
      'data-site-id': 'demo.example',
    });
    const firstChildCountBefore = el.children.length;
    // A successful mount kicks off a 5s polling interval, so we
    // must capture and call the destroy callback at the end of
    // the test — otherwise the timer (and its background fetch
    // attempts) leak into the rest of the suite.
    const destroy = mountInstance(el);
    try {
      const childrenAfterFirst = el.children.length;
      expect(childrenAfterFirst).toBeGreaterThan(firstChildCountBefore);
      // Second call: idempotent no-op, returns immediately, doesn't
      // re-render or duplicate state.
      mountInstance(el);
      expect(el.children.length).toBe(childrenAfterFirst);
    } finally {
      destroy();
    }
  });
});
