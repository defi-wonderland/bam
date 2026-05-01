import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * Builds the comments widget as a single ES module bundle.
 *
 * The widget is the only piece of this demo that needs bundling — the
 * post pages are hand-authored static HTML served as-is by `server.ts`.
 * The output goes to `dist/comments.js`, which the post pages reference
 * via `<script type="module" src="/comments.js">`.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/widget/index.ts'),
      formats: ['es'],
      fileName: () => 'comments.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
