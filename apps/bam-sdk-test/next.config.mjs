/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['bam-sdk', 'c-kzg'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.externals.push('pino-pretty', 'encoding');
    return config;
  },
};

export default nextConfig;
