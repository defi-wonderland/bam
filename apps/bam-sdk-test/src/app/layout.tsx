import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BAM SDK Test App',
  description: 'Interactive surface for the bam-sdk browser API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono">{children}</body>
    </html>
  );
}
