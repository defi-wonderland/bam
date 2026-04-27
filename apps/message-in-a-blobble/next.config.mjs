/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['bam-sdk', 'bam-reader', 'bam-store', 'c-kzg', 'better-sqlite3'],
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
