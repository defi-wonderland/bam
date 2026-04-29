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
