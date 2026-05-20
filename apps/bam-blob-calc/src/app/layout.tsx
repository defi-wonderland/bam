import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Blob vs Calldata Cost',
  description: 'Estimate calldata vs EIP-4844 blob cost for a payload at current Ethereum mainnet fees.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
