// EIP-4844 / EIP-7623 cost math.
// All gas values are bigint. All wei values are bigint.

export const GAS_PER_BLOB = 131_072n;            // 2^17, the blob-fee denominator
export const BLOB_BYTES_RAW = 131_072;            // raw bytes a blob holds (informational)
export const BLOB_BYTES_USABLE = 126_976;         // 4096 field elements × 31 usable bytes
export const TX_BASE_GAS = 21_000n;
export const CALLDATA_NONZERO_GAS = 16n;
export const CALLDATA_ZERO_GAS = 4n;
export const FLOOR_PER_TOKEN = 10n;               // EIP-7623

export type CalldataBreakdown = {
  bytes: number;
  zeroBytes: number;
  nonzeroBytes: number;
  tokens: bigint;
  standardGas: bigint;
  floorGas: bigint;
  gas: bigint;
  weiCost: bigint;
};

export type BlobBreakdown = {
  bytes: number;
  blobs: number;
  blobGas: bigint;
  blobFeeWei: bigint;
  envelopeGas: bigint;
  envelopeFeeWei: bigint;
  totalWei: bigint;
};

export function countBytes(input: Uint8Array): { zero: number; nonzero: number } {
  let zero = 0;
  let nonzero = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0) zero++;
    else nonzero++;
  }
  return { zero, nonzero };
}

export function calldataCost(input: Uint8Array, gasBaseFeeWei: bigint): CalldataBreakdown {
  const { zero, nonzero } = countBytes(input);
  const zeroN = BigInt(zero);
  const nonzeroN = BigInt(nonzero);
  const tokens = zeroN + 4n * nonzeroN;
  const standardGas = TX_BASE_GAS + CALLDATA_ZERO_GAS * zeroN + CALLDATA_NONZERO_GAS * nonzeroN;
  const floorGas = TX_BASE_GAS + FLOOR_PER_TOKEN * tokens;
  const gas = standardGas > floorGas ? standardGas : floorGas;
  return {
    bytes: input.length,
    zeroBytes: zero,
    nonzeroBytes: nonzero,
    tokens,
    standardGas,
    floorGas,
    gas,
    weiCost: gas * gasBaseFeeWei,
  };
}

export function blobsNeeded(byteLen: number): number {
  if (byteLen <= 0) return 0;
  return Math.ceil(byteLen / BLOB_BYTES_USABLE);
}

export function blobCost(
  byteLen: number,
  blobBaseFeeWei: bigint,
  gasBaseFeeWei: bigint,
): BlobBreakdown {
  const blobs = blobsNeeded(byteLen);
  const blobGas = BigInt(blobs) * GAS_PER_BLOB;
  const blobFeeWei = blobGas * blobBaseFeeWei;
  const envelopeGas = TX_BASE_GAS;
  const envelopeFeeWei = envelopeGas * gasBaseFeeWei;
  return {
    bytes: byteLen,
    blobs,
    blobGas,
    blobFeeWei,
    envelopeGas,
    envelopeFeeWei,
    totalWei: blobFeeWei + envelopeFeeWei,
  };
}

const WEI_PER_GWEI = 1_000_000_000n;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

export function weiToGwei(wei: bigint, decimals = 4): string {
  return bigintToDecimal(wei, WEI_PER_GWEI, decimals);
}

export function weiToEth(wei: bigint, decimals = 8): string {
  return bigintToDecimal(wei, WEI_PER_ETH, decimals);
}

export function weiToUsd(wei: bigint, ethUsd: number | null): string | null {
  if (ethUsd === null || ethUsd <= 0) return null;
  const scaledUsd = BigInt(Math.round(ethUsd * 100_000_000)); // USD × 1e8
  const usdScaled = (wei * scaledUsd) / WEI_PER_ETH; // USD × 1e8
  const dollars = Number(usdScaled) / 100_000_000;
  if (dollars >= 100) return `$${dollars.toFixed(2)}`;
  if (dollars >= 1) return `$${dollars.toFixed(3)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(6)}`;
}

function bigintToDecimal(value: bigint, divisor: bigint, decimals: number): string {
  const whole = value / divisor;
  const remainder = value % divisor;
  if (decimals <= 0) return whole.toString();
  const padded = remainder.toString().padStart(String(divisor).length - 1, '0');
  const fractional = padded.slice(0, decimals);
  const trimmed = fractional.replace(/0+$/, '');
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString();
}
