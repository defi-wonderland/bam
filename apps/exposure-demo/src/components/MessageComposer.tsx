'use client';

import { useState } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { keccak256, encodePacked } from 'viem';
import {
  deserializeBLSPrivateKey,
  signBLS,
  serializeBLSSignature,
} from 'bam-sdk/browser';
import { useQueryClient } from '@tanstack/react-query';
import { BLS_REGISTRY_ADDRESS, SEPOLIA_CHAIN_ID, MAX_MESSAGE_CHARS } from '@/lib/constants';
import { BLS_REGISTRY_ABI } from '@/lib/contracts';
import { useBLSKey } from './BLSKeyManager';

export function MessageComposer() {
  const { address, isConnected } = useAccount();
  const { privateKeyHex } = useBLSKey();
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: isRegistered } = useReadContract({
    address: BLS_REGISTRY_ADDRESS,
    abi: BLS_REGISTRY_ABI,
    functionName: 'isRegistered',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const canCompose = isConnected && isRegistered && privateKeyHex;

  const handleSubmit = async () => {
    if (!address || !privateKeyHex || !content.trim()) return;
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      // First, get the nonce from the server (it will assign one)
      // We need to pre-sign with BLS. The server returns the assigned nonce+timestamp,
      // but we need to sign before submitting. So we do a two-step:
      // 1. Ask server for next nonce
      // 2. Compute BLS signature
      // 3. Submit message with signature

      // Get next nonce
      const nonceRes = await fetch(`/api/messages?author=${address.toLowerCase()}`);
      const nonceData = await nonceRes.json();
      const existingMessages = nonceData.messages?.filter(
        (m: { author: string }) => m.author.toLowerCase() === address.toLowerCase()
      ) || [];
      const nonce = existingMessages.length > 0
        ? Math.max(...existingMessages.map((m: { nonce: number }) => m.nonce)) + 1
        : 0;

      const timestamp = Math.floor(Date.now() / 1000);
      const contentBytes = new TextEncoder().encode(content.trim());

      // Compute the domain-separated signed hash matching the contract:
      // domain = keccak256("ERC-BAM.v1" || chainId)
      // messageHash = keccak256(author || nonce(uint64) || contents)
      // signedHash = keccak256(domain || messageHash)
      const domain = keccak256(
        encodePacked(
          ['string', 'uint256'],
          ['ERC-BAM.v1', BigInt(SEPOLIA_CHAIN_ID)]
        )
      );

      const messageHash = keccak256(
        encodePacked(
          ['address', 'uint64', 'bytes'],
          [address, BigInt(nonce), `0x${Buffer.from(contentBytes).toString('hex')}` as `0x${string}`]
        )
      );

      const signedHash = keccak256(
        encodePacked(['bytes32', 'bytes32'], [domain, messageHash])
      );

      // Sign with BLS
      const pk = deserializeBLSPrivateKey(privateKeyHex);
      const blsSig = await signBLS(pk, signedHash);
      const blsSigHex = serializeBLSSignature(blsSig);

      // Submit to server
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: address,
          content: content.trim(),
          blsSignature: blsSigHex,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit message');
      }

      setContent('');
      setSuccess('Message signed and stored. Post a blob to register it on-chain.');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-3">Step 2: Compose Message</h2>

      {!canCompose ? (
        <p className="text-sm text-slate-400">
          {!isConnected
            ? 'Connect your wallet first.'
            : !isRegistered
              ? 'Register your BLS key first.'
              : 'BLS key not found in browser. Generate a new one.'}
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your message..."
              maxLength={MAX_MESSAGE_CHARS}
              rows={3}
              className="input resize-none"
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-slate-500">
                Signed with your BLS key for on-chain verification
              </span>
              <span className={`text-xs ${content.length > MAX_MESSAGE_CHARS ? 'text-red-400' : 'text-slate-500'}`}>
                {content.length}/{MAX_MESSAGE_CHARS}
              </span>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !content.trim()}
            className="btn-primary"
          >
            {isSubmitting ? 'Signing & submitting...' : 'Sign & Submit'}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {success && <p className="text-sm text-emerald-400">{success}</p>}
        </div>
      )}
    </div>
  );
}
