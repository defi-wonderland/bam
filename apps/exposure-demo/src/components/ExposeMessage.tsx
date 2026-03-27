'use client';

import React, { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { toHex } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import {
  deserializeBLSPrivateKey,
  signBLS,
} from 'bam-sdk/browser';
import { BLS_EXPOSER_ADDRESS, SEPOLIA_CHAIN_ID } from '@/lib/constants';
import { BLS_EXPOSER_ABI } from '@/lib/contracts';
import { computeSignedHash } from '@/lib/bam-crypto';
import { useBLSKey } from './BLSKeyManager';

interface ExposureParamsResponse {
  versionedHash: string;
  kzgProofs: Array<{
    z: string;
    y: string;
    commitment: string;
    proof: string;
  }>;
  batchStartOffset: number;
  byteOffset: number;
  byteLength: number;
  messageBytes: string;
  message: {
    author: string;
    timestamp: number;
    nonce: number;
    content: string;
    messageHash: string;
  };
}

interface Props {
  txHash: string;
  messageIndex: number;
  author: string;
  nonce: number;
  content: string;
  timestamp: number;
}

export function ExposeMessage({ txHash, messageIndex, author, nonce, content, timestamp }: Props): React.ReactNode {
  const { address } = useAccount();
  const { privateKeyHex } = useBLSKey();
  const [step, setStep] = useState<'idle' | 'building' | 'signing' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { writeContract, data: exposeTxHash, isPending, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: exposeTxHash,
  });

  // Handle wallet rejection / writeContract errors (issue #3)
  useEffect(() => {
    if (writeError) {
      setError(writeError.message);
      setStep('error');
    }
  }, [writeError]);

  // Only show expose button for messages from the connected user
  const isOwnMessage = address?.toLowerCase() === author.toLowerCase();

  const handleExpose = async () => {
    if (!address || !privateKeyHex) return;
    setError(null);

    try {
      // Step 1: Build KZG proofs on server
      setStep('building');
      const buildRes = await fetch('/api/exposure/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash, messageIndex }),
      });

      if (!buildRes.ok) {
        const data = await buildRes.json();
        throw new Error(data.error || 'Failed to build exposure params');
      }

      const params: ExposureParamsResponse = await buildRes.json();

      // Step 2: Sign message with BLS
      setStep('signing');
      const pk = deserializeBLSPrivateKey(privateKeyHex);

      // Compute signedHash matching the contract
      const signedHash = computeSignedHash(author, nonce, content, SEPOLIA_CHAIN_ID);

      const blsSignature = await signBLS(pk, signedHash);

      // Step 3: Submit expose transaction
      setStep('submitting');

      const contractParams = {
        versionedHash: params.versionedHash as `0x${string}`,
        kzgProofs: params.kzgProofs.map((p) => ({
          z: BigInt(p.z),
          y: BigInt(p.y),
          commitment: p.commitment as `0x${string}`,
          proof: p.proof as `0x${string}`,
        })),
        byteOffset: BigInt(params.byteOffset),
        byteLength: BigInt(params.byteLength),
        messageBytes: params.messageBytes as `0x${string}`,
        blsSignature: toHex(blsSignature),
        registrationProof: '0x' as `0x${string}`,
      };

      writeContract({
        address: BLS_EXPOSER_ADDRESS,
        abi: BLS_EXPOSER_ABI,
        functionName: 'expose',
        args: [contractParams],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStep('error');
    }
  };

  // Update step based on tx state
  useEffect(() => {
    if (isSuccess && step !== 'done') {
      setStep('done');
      queryClient.invalidateQueries({ queryKey: ['exposures'] });
    }
  }, [isSuccess, step, queryClient]);

  if (!isOwnMessage) {
    return null;
  }

  if (step === 'done' || isSuccess) {
    return (
      <div className="flex items-center gap-2">
        <span className="status-badge bg-emerald-900/50 text-emerald-300">Exposed</span>
        {exposeTxHash && (
          <a
            href={`https://sepolia.etherscan.io/tx/${exposeTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-indigo-400 hover:text-indigo-300 underline"
          >
            {exposeTxHash.slice(0, 14)}...
          </a>
        )}
      </div>
    );
  }

  const statusText = {
    idle: 'Expose On-Chain',
    building: 'Building KZG proofs...',
    signing: 'Signing with BLS...',
    submitting: isPending ? 'Confirm in wallet...' : isConfirming ? 'Confirming...' : 'Submitting...',
    error: 'Retry Expose',
  }[step];

  return (
    <div>
      <button
        onClick={handleExpose}
        disabled={step === 'building' || step === 'signing' || step === 'submitting' || isPending || isConfirming}
        className="btn-primary text-xs py-1 px-3"
      >
        {statusText}
      </button>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}
