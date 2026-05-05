/**
 * Auto-mount entrypoint for the BAM comments widget.
 *
 * Embed contract:
 *
 *   <div data-bam-comments
 *        data-post-id="<host-string>"
 *        data-site-id="<optional override>"></div>
 *   <script src="https://<host>/widget.js" defer></script>
 *
 * On load we:
 *   1. Inject the scoped stylesheet once into <head>.
 *   2. Mount on every existing `[data-bam-comments]` element.
 *   3. Watch for elements added later (host pages that hydrate
 *      asynchronously) via a MutationObserver.
 *
 * Each instance is idempotent — `mountInstance` refuses to mount
 * twice on the same node.
 */

import widgetCss from './widget.css?inline';

import { mountInstance } from './render.js';

export { mountInstance };
export { BAM_COMMENTS_TAG } from './content-tag.js';
export { derivePostIdHash, resolveSiteId } from './post-id.js';

const STYLE_TAG_ID = 'bam-comments-style';

function ensureStyleTag(doc: Document): void {
  if (doc.getElementById(STYLE_TAG_ID) !== null) return;
  const tag = doc.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.textContent = widgetCss;
  doc.head.appendChild(tag);
}

function mountAllOn(root: ParentNode): void {
  const targets = root.querySelectorAll<HTMLElement>('[data-bam-comments]');
  targets.forEach((node) => {
    // Defence-in-depth: `mountInstance` already catches its own
    // configuration errors and surfaces them in the node, but if
    // anything ever leaks past those guards we still want the
    // remaining widgets on the page to mount.
    try {
      mountInstance(node);
    } catch (err) {
      try {
        node.textContent = `bam-comments: mount failed (${
          err instanceof Error ? err.message : 'unknown'
        })`;
      } catch {
        /* node may not accept text — last resort, swallow */
      }
    }
  });
}

function bootstrap(): void {
  if (typeof document === 'undefined') return;
  ensureStyleTag(document);

  const run = () => {
    mountAllOn(document);
    // Future-proof: a host page that injects a comments div after
    // the script tag has executed should still get mounted.
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches?.('[data-bam-comments]')) mountInstance(n);
          mountAllOn(n);
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

bootstrap();
