/**
 * Thin wrapper around `window.ethereum` (EIP-1193) for the demo's
 * comments widget. The widget swaps wagmi/RainbowKit for direct
 * EIP-1193 calls in the spirit of the static-site embed
 * ("integration surface = one script tag"). This module is the
 * single place where `window.ethereum` is reached for, so:
 *
 *   - the rest of the widget stays testable without a wallet stub,
 *   - error mapping (wallet rejection, missing wallet, unsupported
 *     method) lives in one place,
 *   - the v-byte normalization that bam-sdk does internally is
 *     replicated here so what the widget submits to the Poster
 *     looks identical to what bam-sdk would have produced.
 *
 * Per the *Leaking internal error messages to callers*
 * anti-pattern, raw provider error strings never escape: each
 * thrown error is one of the typed classes below and carries a
 * stable `code` discriminator the renderer can branch on.
 */

import type { Hex } from 'viem';

import type { BAMMessageTypedData } from './typed-data.js';

export type WalletErrorCode =
  | 'wallet_not_installed'
  | 'request_rejected'
  | 'unsupported_method'
  | 'disconnected'
  | 'bad_signature_shape'
  | 'unknown';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  // eslint-disable-next-line no-var
  var ethereum: Eip1193Provider | undefined;
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** Test seam: lets unit tests inject a stub provider. */
let providerOverride: Eip1193Provider | null = null;

export function __setEthereumProviderForTests(
  provider: Eip1193Provider | null
): void {
  providerOverride = provider;
}

function getProvider(): Eip1193Provider {
  const p =
    providerOverride ??
    (typeof globalThis !== 'undefined'
      ? (globalThis as { ethereum?: Eip1193Provider }).ethereum
      : undefined);
  if (p === undefined) {
    throw new WalletError(
      'wallet_not_installed',
      'no EIP-1193 provider on window.ethereum'
    );
  }
  return p;
}

/**
 * Prompts the wallet to connect and returns the first selected
 * address. Throws a `WalletError` of code `request_rejected` if
 * the user dismisses the prompt.
 */
export async function connect(): Promise<Hex> {
  const provider = getProvider();
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (err) {
    throw mapProviderError(err);
  }
  if (
    !Array.isArray(accounts) ||
    accounts.length === 0 ||
    typeof accounts[0] !== 'string'
  ) {
    throw new WalletError(
      'unknown',
      'eth_requestAccounts returned an unexpected shape'
    );
  }
  return accounts[0] as Hex;
}

/**
 * Returns the wallet's currently connected address without
 * prompting (returns `null` if not connected). Useful on page
 * load to decide whether to render the composer or the connect
 * button.
 */
export async function getConnectedAddress(): Promise<Hex | null> {
  const provider = getProvider();
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: 'eth_accounts' });
  } catch (err) {
    throw mapProviderError(err);
  }
  if (Array.isArray(accounts) && typeof accounts[0] === 'string') {
    return accounts[0] as Hex;
  }
  return null;
}

/**
 * Returns the wallet's current chain id (decimal). Throws
 * `WalletError` if the request fails.
 */
export async function getChainId(): Promise<number> {
  const provider = getProvider();
  let raw: unknown;
  try {
    raw = await provider.request({ method: 'eth_chainId' });
  } catch (err) {
    throw mapProviderError(err);
  }
  if (typeof raw !== 'string') {
    throw new WalletError('unknown', 'eth_chainId returned an unexpected shape');
  }
  return Number.parseInt(raw, 16);
}

/**
 * Signs a BAM EIP-712 typed-data payload via
 * `eth_signTypedData_v4`. Returns a 65-byte hex signature with
 * `v` normalized to {27, 28} (matching bam-sdk's
 * `signECDSA` output).
 */
export async function signTypedData(args: {
  address: Hex;
  typedData: BAMMessageTypedData;
}): Promise<Hex> {
  const provider = getProvider();
  let raw: unknown;
  try {
    raw = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [args.address, JSON.stringify(args.typedData)],
    });
  } catch (err) {
    throw mapProviderError(err);
  }
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(raw)) {
    throw new WalletError(
      'bad_signature_shape',
      'wallet returned a non-65-byte signature'
    );
  }
  return normalizeEcdsaV(raw as Hex);
}

/**
 * Subscribes to wallet account changes. Returns an unsubscribe
 * function. Silent no-op if the provider does not expose `on`.
 */
export function onAccountsChanged(
  handler: (next: Hex | null) => void
): () => void {
  const provider = getProvider();
  if (provider.on === undefined) return () => {};
  const wrapped = (...args: unknown[]): void => {
    const accounts = args[0];
    if (Array.isArray(accounts) && typeof accounts[0] === 'string') {
      handler(accounts[0] as Hex);
    } else {
      handler(null);
    }
  };
  provider.on('accountsChanged', wrapped);
  return () => provider.removeListener?.('accountsChanged', wrapped);
}

function mapProviderError(err: unknown): WalletError {
  // EIP-1193 ProviderRpcError: { code, message, data? }.
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'number'
  ) {
    const code = (err as { code: number }).code;
    switch (code) {
      case 4001:
        return new WalletError('request_rejected', 'user rejected request');
      case 4100:
        return new WalletError(
          'request_rejected',
          'method not authorized by wallet'
        );
      case 4200:
        return new WalletError(
          'unsupported_method',
          'wallet does not support the requested method'
        );
      case 4900:
      case 4901:
        return new WalletError('disconnected', 'wallet is disconnected');
      default:
        return new WalletError('unknown', `provider error code ${code}`);
    }
  }
  return new WalletError('unknown', 'provider error');
}

function normalizeEcdsaV(sig: Hex): Hex {
  const bytes = hexToBytes(sig);
  if (bytes.length !== 65) {
    throw new WalletError(
      'bad_signature_shape',
      `expected 65-byte signature, got ${bytes.length}`
    );
  }
  const v = bytes[64];
  if (v === 0 || v === 1) {
    bytes[64] = v + 27;
  } else if (v !== 27 && v !== 28) {
    throw new WalletError(
      'bad_signature_shape',
      `non-canonical v byte 0x${v.toString(16)}`
    );
  }
  return bytesToHex(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): Hex {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as Hex;
}
