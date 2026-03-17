'use client';

import { useState } from 'react';

const SEPOLIA_ETHERSCAN = 'https://sepolia.etherscan.io';

interface AddressLinkProps {
  address: string;
  className?: string;
  short?: boolean;
}

export function AddressLink({ address, className = '', short = true }: AddressLinkProps) {
  const [copied, setCopied] = useState(false);
  const display = short ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
  const url = `${SEPOLIA_ETHERSCAN}/address/${address}`;

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-ocean-600 hover:text-ocean-800 underline"
      >
        {display}
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className="text-sand-400 hover:text-ocean-600 p-0.5 rounded focus:outline-none focus:ring-2 focus:ring-ocean-300"
        title="Copy address"
      >
        {copied ? (
          <span className="text-xs text-palm-600">Copied!</span>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        )}
      </button>
    </span>
  );
}
