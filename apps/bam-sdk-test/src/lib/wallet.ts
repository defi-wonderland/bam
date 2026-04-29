'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createWalletClient,
  custom,
  defineChain,
  type Address,
  type Chain,
  type WalletClient,
} from 'viem';

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

interface WalletState {
  client: WalletClient | null;
  address: Address | null;
  chainId: number | null;
  error: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  available: boolean;
}

/**
 * `signECDSA` reads the chain id from `walletClient.chain.id`. We don't
 * know which chain the wallet is on at compile time, so we synthesise a
 * minimal viem `Chain` per chain id — only the id is consulted by the
 * SDK, the rest is filler that satisfies viem's type without prescribing
 * an RPC URL.
 */
function chainForId(id: number): Chain {
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

export function useInjectedWallet(): WalletState {
  const [client, setClient] = useState<WalletClient | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(typeof window !== 'undefined' && !!window.ethereum);
  }, []);

  const buildClient = useCallback((acct: Address, id: number) => {
    if (!window.ethereum) return null;
    return createWalletClient({
      account: acct,
      chain: chainForId(id),
      transport: custom(window.ethereum),
    });
  }, []);

  const connect = useCallback(async () => {
    setError('');
    if (!window.ethereum) {
      setError('No injected wallet detected (window.ethereum is undefined).');
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];
      const chainHex = (await window.ethereum.request({
        method: 'eth_chainId',
      })) as string;
      const acct = accounts[0] as Address;
      const id = parseInt(chainHex, 16);
      setAddress(acct);
      setChainId(id);
      setClient(buildClient(acct, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [buildClient]);

  const disconnect = useCallback(() => {
    setClient(null);
    setAddress(null);
    setChainId(null);
    setError('');
  }, []);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on || !eth.removeListener) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      const next = (accounts[0] ?? null) as Address | null;
      setAddress(next);
      setClient(next && chainId != null ? buildClient(next, chainId) : null);
    };
    const onChain = (...args: unknown[]) => {
      const id = parseInt(args[0] as string, 16);
      setChainId(id);
      setClient(address ? buildClient(address, id) : null);
    };
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, [address, chainId, buildClient]);

  return { client, address, chainId, error, connect, disconnect, available };
}
