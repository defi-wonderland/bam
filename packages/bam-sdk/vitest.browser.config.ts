import { defineConfig, configDefaults } from 'vitest/config';

/**
 * Browser-environment test project (jsdom). Verifies that the SDK's
 * public primitives behave identically to the Node run — specifically
 * that ECDSA signing produces byte-identical signatures across
 * runtimes.
 *
 * Kept as a separate config so `pnpm test:run` stays Node-only.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/browser/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/integration/**'],
  },
});
