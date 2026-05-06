/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['bam-sdk'],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
