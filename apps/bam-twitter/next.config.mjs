/** @type {import('next').NextConfig} */
const nextConfig = {
  // `bam-sdk` is externalized so its ESM-only build isn't bundled into
  // server chunks. This app only imports `bam-sdk/browser`, so c-kzg
  // never enters the dependency graph — no need to externalize it.
  serverExternalPackages: ['bam-sdk'],
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
