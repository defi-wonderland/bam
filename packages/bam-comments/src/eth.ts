/**
 * Minimal EIP-1193 wallet wrapper. Exists so the widget never carries
 * `wagmi` / `viem`'s wallet adapters — the RPC surface this widget
 * needs (`eth_requestAccounts`, `eth_chainId`,
 * `wallet_switchEthereumChain`, `eth_signTypedData_v4`, plus
 * `accountsChanged`) is small enough to inline.
 *
 * Errors are mapped to typed `WalletError` codes so raw provider
 * strings never bubble up to the UI.
 */

import { hexToBytes, bytesToHex } from './hex.js';
import { serializeTypedDataForRpc, type BamTypedData } from './typed-data.js';

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_HEX = '0xaa36a7';

export type WalletErrorCode =
  | 'wallet_not_installed'
  | 'request_rejected'
  | 'unsupported_method'
  | 'disconnected'
  | 'bad_signature_shape'
  | 'wrong_chain'
  | 'unknown';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Subset of EIP-1193 we use, typed loosely to match real providers. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', cb: (...a: unknown[]) => void): void;
  removeListener?(event: 'accountsChanged' | 'chainChanged', cb: (...a: unknown[]) => void): void;
}

/**
 * Read `window.ethereum`. Decoupled from the rest of the wallet
 * surface so tests can inject a stub provider without going through
 * a global.
 */
export function getProvider(): Eip1193Provider | null {
  const w = (typeof window === 'undefined'
    ? undefined
    : (window as unknown as { ethereum?: Eip1193Provider })) ?? undefined;
  return w?.ethereum ?? null;
}

export async function requestAccount(provider: Eip1193Provider): Promise<`0x${string}`> {
  const accounts = await callOrThrow<unknown>(provider, 'eth_requestAccounts');
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new WalletError('disconnected', 'no accounts returned');
  }
  // Defensive: a non-spec-compliant provider could return a non-string
  // first element; calling `.toLowerCase()` on that throws a TypeError
  // outside the WalletError mapping path and leaks raw stack traces to
  // the UI. Match the type guard `readExistingAccount` already uses.
  const first = accounts[0];
  if (typeof first !== 'string') {
    throw new WalletError(
      'unknown',
      `eth_requestAccounts returned ${typeof first} at index 0`
    );
  }
  return first.toLowerCase() as `0x${string}`;
}

export async function getChainId(provider: Eip1193Provider): Promise<number> {
  const raw = await callOrThrow<string>(provider, 'eth_chainId');
  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new WalletError('unknown', `unexpected chainId: ${String(raw)}`);
  }
  return parseInt(raw, 16);
}

/**
 * Prompt the wallet to switch to Sepolia. Throws `wrong_chain` if the
 * user declines. We don't `wallet_addEthereumChain` because Sepolia
 * is a built-in chain in every major wallet — adding it would imply
 * to the user this is a custom RPC, which it isn't.
 */
export async function ensureSepolia(provider: Eip1193Provider): Promise<void> {
  const id = await getChainId(provider);
  if (id === SEPOLIA_CHAIN_ID) return;
  try {
    await callOrThrow(provider, 'wallet_switchEthereumChain', [
      { chainId: SEPOLIA_CHAIN_HEX },
    ]);
  } catch (err) {
    if (err instanceof WalletError && err.code === 'request_rejected') {
      throw new WalletError('wrong_chain', 'user declined chain switch');
    }
    throw err;
  }
  const after = await getChainId(provider);
  if (after !== SEPOLIA_CHAIN_ID) {
    throw new WalletError('wrong_chain', `still on chain ${after}`);
  }
}

const SIGNATURE_HEX_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Sign EIP-712 typed data via `eth_signTypedData_v4`. Returns a
 * 0x-prefixed 65-byte hex string with `v ∈ {27, 28}` — viem's encoder
 * sometimes returns `v ∈ {0, 1}`, so we always normalise via
 * `normalizeEcdsaV` to keep the wire format byte-identical to what
 * `bam-sdk`'s `signECDSA` produces.
 *
 * Pre-checked with `SIGNATURE_HEX_RE` so a wallet returning
 * non-canonical hex (truncated, mixed in non-hex, missing `0x`)
 * fails fast with a typed `bad_signature_shape` rather than
 * surfacing as a length error after `hexToBytes`.
 */
export async function signTypedData(
  provider: Eip1193Provider,
  account: `0x${string}`,
  td: BamTypedData
): Promise<`0x${string}`> {
  const json = serializeTypedDataForRpc(td);
  const sig = await callOrThrow<string>(provider, 'eth_signTypedData_v4', [
    account,
    json,
  ]);
  if (typeof sig !== 'string' || !SIGNATURE_HEX_RE.test(sig)) {
    throw new WalletError(
      'bad_signature_shape',
      `expected 65-byte hex signature, got ${typeof sig === 'string' ? `${sig.length}-char string` : typeof sig}`
    );
  }
  return normalizeEcdsaV(sig as `0x${string}`);
}

/**
 * Normalise the 65th byte of an ECDSA signature from `{0, 1}` to
 * `{27, 28}` and validate length / shape. `bam-sdk` does the same
 * work in `signatures.ts`; this is the widget-side mirror so the
 * imported surface stays slim.
 */
export function normalizeEcdsaV(sig: `0x${string}`): `0x${string}` {
  const bytes = hexToBytes(sig);
  if (bytes.length !== 65) {
    throw new WalletError(
      'bad_signature_shape',
      `non-65-byte signature (got ${bytes.length})`
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

/**
 * Map EIP-1193 numeric error codes to typed `WalletError` codes.
 * Documented codes: 4001 user rejected, 4100 unauthorised, 4200
 * unsupported method, 4900 disconnected, 4901 chain disconnected.
 * Anything we don't recognise becomes `unknown` — the original
 * provider message is preserved for debugging but never displayed to
 * the user.
 */
export function mapProviderError(err: unknown): WalletError {
  const e = err as { code?: number; message?: string } | null | undefined;
  if (!e || typeof e !== 'object') {
    return new WalletError('unknown', 'non-object error');
  }
  const code = typeof e.code === 'number' ? e.code : undefined;
  const msg = typeof e.message === 'string' ? e.message : undefined;
  if (code === 4001) return new WalletError('request_rejected', msg);
  if (code === 4100) return new WalletError('request_rejected', msg);
  if (code === 4200) return new WalletError('unsupported_method', msg);
  if (code === 4900 || code === 4901) return new WalletError('disconnected', msg);
  return new WalletError('unknown', msg);
}

async function callOrThrow<T>(
  provider: Eip1193Provider,
  method: string,
  params?: unknown[]
): Promise<T> {
  try {
    return (await provider.request({ method, params })) as T;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw mapProviderError(err);
  }
}

/**
 * Subscribe to `accountsChanged`. The handler receives the active
 * account or `null` when the wallet emits an empty array
 * (disconnect). Returns a cleanup function. Some minimal providers
 * don't implement `on` at all; the unsubscriber is a no-op in that
 * case.
 */
export function onAccountsChanged(
  provider: Eip1193Provider,
  cb: (account: `0x${string}` | null) => void
): () => void {
  if (typeof provider.on !== 'function') return () => {};
  const handler = (a: unknown) => {
    if (!Array.isArray(a)) return;
    const first = a[0];
    cb(typeof first === 'string' ? (first.toLowerCase() as `0x${string}`) : null);
  };
  provider.on('accountsChanged', handler);
  return () => {
    provider.removeListener?.('accountsChanged', handler);
  };
}

/**
 * Read the currently authorised account without prompting the user.
 * `eth_accounts` returns `[]` when the wallet has no remembered
 * connection for this origin — we map both that and a missing
 * provider to `null` so the bootstrap path stays branch-free.
 */
export async function readExistingAccount(
  provider: Eip1193Provider
): Promise<`0x${string}` | null> {
  try {
    const accs = await provider.request({ method: 'eth_accounts' });
    if (Array.isArray(accs) && accs.length > 0 && typeof accs[0] === 'string') {
      return accs[0].toLowerCase() as `0x${string}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function requireProvider(): Eip1193Provider {
  const p = getProvider();
  if (p === null) {
    throw new WalletError('wallet_not_installed', 'window.ethereum missing');
  }
  return p;
}
