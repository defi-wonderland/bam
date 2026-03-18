import { NextResponse } from 'next/server';
import { createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { COOLDOWN_MS, getLastPostTime } from '@/lib/poster-state';

export async function GET() {
  try {
    const posterKey = process.env.POSTER_PRIVATE_KEY;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

    if (!posterKey) {
      return NextResponse.json(
        { error: 'Server wallet not configured' },
        { status: 500 }
      );
    }

    const account = privateKeyToAccount(posterKey as `0x${string}`);
    const address = account.address;

    let balance: string | null = null;
    if (rpcUrl) {
      const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl),
      });
      const balanceWei = await publicClient.getBalance({ address });
      balance = formatEther(balanceWei);
    }

    const lastPostTime = await getLastPostTime();
    const now = Date.now();
    const cooldownRemaining = lastPostTime
      ? Math.max(0, COOLDOWN_MS - (now - lastPostTime))
      : 0;
    const nextEligibleTime = lastPostTime
      ? lastPostTime + COOLDOWN_MS
      : null;

    return NextResponse.json({
      address,
      balance,
      lastPostTime,
      nextEligibleTime,
      cooldownRemainingMs: cooldownRemaining,
      canPostNow: cooldownRemaining === 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
