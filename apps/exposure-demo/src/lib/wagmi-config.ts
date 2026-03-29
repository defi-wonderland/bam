import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { sepolia } from 'wagmi/chains';
import { http } from 'wagmi';

export const config = getDefaultConfig({
  appName: 'BAM Exposure Demo',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo',
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined),
  },
  ssr: true,
});
