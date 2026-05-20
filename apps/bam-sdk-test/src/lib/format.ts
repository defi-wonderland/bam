import { bytesToHex } from 'bam-sdk/browser';

/**
 * Stringify any SDK return value for display: hex for Uint8Array,
 * JSON for objects (with bigint and Uint8Array reduced to hex/string).
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === 'object') {
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Uint8Array) return bytesToHex(v);
        return v;
      },
      2
    );
  }
  return String(value);
}

export const DEMO_CONTENT_TAG = ('0x' + '01'.repeat(32)) as `0x${string}`;
export const DEMO_MESSAGE_TEXT = 'Hello from BAM!';
export const DEMO_CHAIN_ID = 11_155_111;

/**
 * Sepolia RPC URL. Override via NEXT_PUBLIC_SEPOLIA_RPC_URL for a private endpoint;
 * the default is a public provider, fine for low-traffic demo use.
 */
export const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';

/** Sepolia BPE deployment (see packages/bam-contracts/deployments/11155111.json). */
export const SEPOLIA_BPE = {
  dictionary: '0x2265A46e594a67E1d54755BF45362deaacF55A64' as `0x${string}`,
  decoderAggregate: '0x71Ce0a68B1DFB9CcaE6C2A1a00840c9248d7B41f' as `0x${string}`,
  decoderPerMessage: '0xCF8c9477f2EaB21Db47a66AA18805350c2F714c6' as `0x${string}`,
  identity:
    '0xddb40bbb8fc7605ce970c5dd9b8a68cc70031aa313bba956e9d83002bbfa0bb0' as `0x${string}`,
} as const;
