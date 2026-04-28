/** @type {import('next').NextConfig} */
const nextConfig = {
  // `@electric-sql/pglite` resolves its WASM with
  // `new URL('postgres.wasm', import.meta.url)`. Next.js's server
  // bundler mangles `import.meta.url` into a webpack-internal value
  // and a downstream fs call rejects the URL with
  // "ERR_INVALID_ARG_TYPE". Externalising the package lets Node
  // resolve the import natively so `import.meta.url` stays a real
  // file:// URL and the WASM loads.
  serverExternalPackages: [
    'bam-sdk',
    'bam-reader',
    'bam-store',
    'c-kzg',
    '@electric-sql/pglite',
  ],
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    config.externals.push('pino-pretty', 'encoding');
    if (isServer) {
      // `serverExternalPackages` only externalises packages discovered
      // as direct dependencies. `@electric-sql/pglite` reaches us
      // transitively through workspace `bam-store`, so Next's webpack
      // still bundles it into a vendor chunk and that bundling breaks
      // PGLite's `new URL('postgres.wasm', import.meta.url)` WASM
      // loader. Force-externalise it (and its sub-paths) so Node
      // resolves it natively at runtime.
      const externalsCallback = ({ request }, callback) => {
        if (request === '@electric-sql/pglite' ||
            request?.startsWith('@electric-sql/pglite/')) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };
      config.externals.push(externalsCallback);
    }
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,
    };
    return config;
  },
};

export default nextConfig;
