import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BAM Explorer',
  description: 'Read-only monitoring dashboard for a BAM Reader + Poster pair.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
