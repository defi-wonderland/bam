'use client';

import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from '@/lib/wagmi-config';
import '@rainbow-me/rainbowkit/styles.css';

/**
 * Global react-query defaults:
 *  - `refetchIntervalInBackground: false` — pause `refetchInterval`
 *    polling when the tab is not visible. In v5 this is the default,
 *    but we set it explicitly so the focus-gating behavior is a
 *    property of the provider rather than of every individual
 *    `useQuery` call site. Our polled endpoints (`/api/blobbles`,
 *    `/api/poster-status`) hit RPCs or the Poster, so silencing them
 *    while the user is on another tab is a real win.
 *  - `refetchOnWindowFocus: true` — refetch immediately when the user
 *    comes back, so stale data is a non-issue.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
