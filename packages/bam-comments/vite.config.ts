/**
 * Vite library build for the embeddable comments widget.
 *
 * One entry → one unhashed `dist/widget.js`, IIFE format. The host
 * page references it with a plain `<script src="/widget.js" defer>`
 * — no `type="module"` required, no CORS preflight. The IIFE's
 * named global (`window.BamComments`) exposes the package's named
 * exports for any embedder that wants to call `mountInstance` or
 * `derivePostIdHash` programmatically; the auto-mount side effect
 * runs as part of the IIFE body.
 *
 * CSS is inlined via `?inline` imports inside the source, so no
 * separate stylesheet is emitted.
 */

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    // Expose VITE_POSTER_URL / VITE_READER_URL at build time so the
    // widget calls upstreams directly with no env handshake at runtime.
    'import.meta.env.VITE_POSTER_URL': JSON.stringify(
      process.env.VITE_POSTER_URL ?? 'http://localhost:8787'
    ),
    'import.meta.env.VITE_READER_URL': JSON.stringify(
      process.env.VITE_READER_URL ?? 'http://localhost:8788'
    ),
  },
  build: {
    target: 'es2022',
    cssMinify: true,
    minify: 'esbuild',
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: path.resolve(here, 'src/index.ts'),
      formats: ['iife'],
      // Required by Vite for IIFE; doubles as the global the
      // widget hangs its named exports off (`window.BamComments`).
      name: 'BamComments',
      fileName: () => 'widget.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'widget.js',
        chunkFileNames: 'widget-[hash].js',
        // Inline every dynamic chunk: a single file is the whole
        // public contract.
        inlineDynamicImports: true,
      },
    },
  },
});
