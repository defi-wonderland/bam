'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi';
import { toHex } from 'viem';
import {
  generateBLSPrivateKey,
  deriveBLSPublicKey,
  serializeBLSPrivateKey,
  serializeBLSPublicKey,
  deserializeBLSPrivateKey,
} from 'bam-sdk/browser';
import { BLS_REGISTRY_ADDRESS, SEPOLIA_CHAIN_ID } from '@/lib/constants';
import { BLS_REGISTRY_ABI } from '@/lib/contracts';
import { computePopSignature } from '@/lib/bam-crypto';

const LS_KEY_PREFIX = 'bam-exposure-demo-bls-key-';

function getStoredKey(address: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LS_KEY_PREFIX + address.toLowerCase());
}

function storeKey(address: string, privateKeyHex: string) {
  localStorage.setItem(LS_KEY_PREFIX + address.toLowerCase(), privateKeyHex);
}

export function useBLSKey() {
  const { address } = useAccount();
  const [privateKeyHex, setPrivateKeyHex] = useState<string | null>(null);
  const [publicKeyHex, setPublicKeyHex] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setPrivateKeyHex(null);
      setPublicKeyHex(null);
      return;
    }
    const stored = getStoredKey(address);
    if (stored) {
      setPrivateKeyHex(stored);
      const pk = deserializeBLSPrivateKey(stored);
      setPublicKeyHex(serializeBLSPublicKey(deriveBLSPublicKey(pk)));
    }
  }, [address]);

  const generate = useCallback(() => {
    if (!address) return;
    const pk = generateBLSPrivateKey();
    const hex = serializeBLSPrivateKey(pk);
    storeKey(address, hex);
    setPrivateKeyHex(hex);
    setPublicKeyHex(serializeBLSPublicKey(deriveBLSPublicKey(pk)));
  }, [address]);

  return { privateKeyHex, publicKeyHex, generate, hasKey: !!privateKeyHex };
}

export function BLSKeyManager() {
  const { address, isConnected } = useAccount();
  const { privateKeyHex, publicKeyHex, generate, hasKey } = useBLSKey();
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if already registered on-chain
  const { data: isRegistered, refetch: refetchRegistration } = useReadContract({
    address: BLS_REGISTRY_ADDRESS,
    abi: BLS_REGISTRY_ABI,
    functionName: 'isRegistered',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContractAsync, data: txHash, isPending: isTxPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (isConfirmed) {
      refetchRegistration();
      setIsRegistering(false);
    }
  }, [isConfirmed, refetchRegistration]);

  const handleRegister = async () => {
    if (!address || !privateKeyHex || !publicKeyHex) return;
    setError(null);
    setIsRegistering(true);

    try {
      const pk = deserializeBLSPrivateKey(privateKeyHex);
      const pubKeyBytes = deriveBLSPublicKey(pk);

      // Compute and sign PoP
      const popSignature = await computePopSignature(
        pk, address, pubKeyBytes, SEPOLIA_CHAIN_ID, BLS_REGISTRY_ADDRESS
      );

      // Submit registration tx (await so rejections are caught)
      await writeContractAsync({
        address: BLS_REGISTRY_ADDRESS,
        abi: BLS_REGISTRY_ABI,
        functionName: 'register',
        args: [toHex(pubKeyBytes), toHex(popSignature)],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      setIsRegistering(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold mb-2">Step 1: BLS Key</h2>
        <p className="text-sm text-slate-400">Connect your wallet to get started.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">Step 1: BLS Key Registration</h2>

      {isRegistered ? (
        <div className="flex items-center gap-2">
          <span className="status-badge bg-emerald-900/50 text-emerald-300">Registered</span>
          {publicKeyHex && (
            <span className="mono truncate max-w-xs">{publicKeyHex.slice(0, 20)}...</span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {!hasKey ? (
            <div>
              <p className="text-sm text-slate-400 mb-2">
                Generate a BLS12-381 keypair. The private key is stored in your browser only.
              </p>
              <button onClick={generate} className="btn-primary">
                Generate BLS Key
              </button>
            </div>
          ) : (
            <div>
              <p className="text-sm text-slate-400 mb-1">Public key:</p>
              <p className="mono mb-3">{publicKeyHex?.slice(0, 30)}...</p>
              <button
                onClick={handleRegister}
                disabled={isRegistering || isTxPending || isConfirming}
                className="btn-primary"
              >
                {isTxPending
                  ? 'Confirm in wallet...'
                  : isConfirming
                    ? 'Confirming...'
                    : 'Register BLS Key On-Chain'}
              </button>
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
