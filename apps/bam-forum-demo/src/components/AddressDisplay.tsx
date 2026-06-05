'use client';

interface AddressDisplayProps {
  address: string;
  ensName?: string | null;
  className?: string;
}

function truncate(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AddressDisplay({ address, ensName, className }: AddressDisplayProps) {
  const label = ensName ?? truncate(address);
  return (
    <a
      href={`https://sepolia.etherscan.io/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-xs text-slate-600 hover:text-slate-900 hover:underline ${
        className ?? ''
      }`}
      title={address}
    >
      {label}
    </a>
  );
}
