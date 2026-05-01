import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Localhost defaults when no env vars are set — matches the
// workspace's `pnpm dev` orchestration that brings up Poster on
// :8787 and Reader on :8788. Shell env or `.env.local` override.
process.env.VITE_POSTER_URL ||= 'http://localhost:8787';
process.env.VITE_READER_URL ||= 'http://localhost:8788';

/**
 * Multi-page static site. Six HTML entries (1 index + 5 post
 * pages) at the project root; the comments widget is referenced
 * from each via `<script type="module" src="/src/widget/index.ts">`
 * and bundled into hashed `dist/assets/*.js` chunks at build
 * time. The output directory `dist/` is the entire deploy
 * artifact — drop it on any static host (Vercel, Netlify, S3,
 * GitHub Pages, IPFS, fly volumes).
 *
 * Build-time env vars `VITE_POSTER_URL` and `VITE_READER_URL`
 * (both required for direct mode) are baked into the bundle by
 * Vite. Without them the widget falls back to same-origin
 * `/api/*` paths — no longer wired up after `server.ts` was
 * dropped, so a deploy without those env vars won't be able to
 * read or post comments.
 */
export default defineConfig({
  server: {
    port: 3002,
    strictPort: true,
  },
  preview: {
    port: 3002,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        'secure-llms': resolve(__dirname, 'secure-llms.html'),
        'balance-of-power': resolve(__dirname, 'balance-of-power.html'),
        societies: resolve(__dirname, 'societies.html'),
        plinko: resolve(__dirname, 'plinko.html'),
        galaxybrain: resolve(__dirname, 'galaxybrain.html'),
      },
    },
  },
});
