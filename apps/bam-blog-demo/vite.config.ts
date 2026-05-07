/**
 * Static MPA build for the demo blog. The widget is built as a
 * separate artifact in `packages/bam-comments`; we copy its output
 * into `public/widget.js` at build time so the embed snippet's
 * `<script src="/widget.js" defer>` resolves with no special
 * server-side handling — exactly what an external host would
 * configure.
 */

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetDist = path.resolve(here, '../../packages/bam-comments/dist/widget.js');
const publicDir = path.join(here, 'public');

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Vite plugin: stage the widget into `public/widget.js` before
 * Vite's own copy step runs. Skips silently when the widget hasn't
 * been built yet so `pnpm dev` still works in isolation.
 */
function stageWidget() {
  return {
    name: 'bam-comments-stage-widget',
    async buildStart() {
      if (!(await exists(widgetDist))) {
        this.warn(
          `bam-comments widget not built at ${widgetDist} — run \`pnpm -F bam-comments build\` first.`
        );
        return;
      }
      await mkdir(publicDir, { recursive: true });
      await copyFile(widgetDist, path.join(publicDir, 'widget.js'));
    },
  };
}

export default defineConfig({
  root: here,
  publicDir: 'public',
  plugins: [stageWidget()],
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(here, 'index.html'),
        post1: path.resolve(here, 'post-1.html'),
        post2: path.resolve(here, 'post-2.html'),
      },
    },
  },
});
