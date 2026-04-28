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
  webpack: (config) => {
    config.externals.push('pino-pretty', 'encoding');
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,
    };
    return config;
  },
};

export default nextConfig;
