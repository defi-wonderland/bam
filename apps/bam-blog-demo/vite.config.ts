import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';

// Localhost defaults when no env vars are set — matches the
// workspace's `pnpm dev` orchestration that brings up Poster on
// :8787 and Reader on :8788. Shell env or `.env.local` override.
process.env.VITE_POSTER_URL ||= 'http://localhost:8787';
process.env.VITE_READER_URL ||= 'http://localhost:8788';

const ROOT = __dirname;

/**
 * In dev (`vite serve`), HTML files reference `/widget.js` —
 * the same URL an external embedder would use — so we don't have
 * to ship two HTMLs. This plugin transparently maps that URL to
 * the source entrypoint Vite knows how to transform on demand.
 */
function aliasWidgetUrlInDev(): Plugin {
  return {
    name: 'bam-blog-demo:alias-widget-url',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        if (url === '/widget.js' || url.startsWith('/widget.js?')) {
          req.url = '/src/widget/index.ts' + url.slice('/widget.js'.length);
        }
        next();
      });
    },
  };
}

/**
 * After `vite build` (lib mode) writes `dist/widget.js`, copy
 * the static demo: 6 HTML files at the project root and
 * everything in `public/`. The result is one `dist/` directory
 * that's the entire deploy artifact.
 */
function copyDemoStatics(): Plugin {
  return {
    name: 'bam-blog-demo:copy-demo-statics',
    apply: 'build',
    closeBundle() {
      const dist = resolve(ROOT, 'dist');
      mkdirSync(dist, { recursive: true });
      for (const entry of readdirSync(ROOT)) {
        if (entry.endsWith('.html')) {
          copyFileSync(resolve(ROOT, entry), resolve(dist, entry));
        }
      }
      const publicDir = resolve(ROOT, 'public');
      try {
        for (const entry of readdirSync(publicDir)) {
          const src = resolve(publicDir, entry);
          if (statSync(src).isFile()) {
            copyFileSync(src, resolve(dist, entry));
          }
        }
      } catch {
        // public/ optional
      }
    },
  };
}

/**
 * The widget bundle is `lib`-mode → `dist/widget.js` (stable,
 * unhashed). Embedders reference that exact URL. The demo's HTML
 * files do the same — they're just one consumer of the widget,
 * not a special inner build.
 */
export default defineConfig({
  publicDir: false, // we copy from public/ ourselves in build
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
    cssCodeSplit: false,
    lib: {
      entry: resolve(ROOT, 'src/widget/index.ts'),
      formats: ['es'],
      fileName: () => 'widget.js',
    },
    rollupOptions: {
      output: {
        // Keep CSS and other assets at predictable names too.
        assetFileNames: '[name][extname]',
      },
    },
  },
  plugins: [aliasWidgetUrlInDev(), copyDemoStatics()],
});
