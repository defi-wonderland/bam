import type { Address } from 'bam-sdk';

/**
 * Minimal Ethereum JSON-RPC surface the startup reconciliation needs.
 * The real Poster factory wraps a viem `PublicClient`; tests pass a stub.
 */
export interface ReconcileRpcClient {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<`0x${string}`>;
}

export interface ReconcileConfig {
  chainId: number;
  bamCoreAddress: Address;
}

export class StartupReconciliationError extends Error {}

/**
 * Startup self-check (plan §C-8):
 *   - `eth_chainId` matches `config.chainId`.
 *   - `eth_getCode(bamCoreAddress)` is non-empty.
 *
 * Throws before the submission loop starts. Mis-matched chain-ID or
 * absent contract code here means every submission would land on the
 * wrong target; fail loudly, not silently.
 */
export async function reconcileStartup(
  rpc: ReconcileRpcClient,
  config: ReconcileConfig
): Promise<void> {
  const chainId = await rpc.getChainId();
  if (chainId !== config.chainId) {
    throw new StartupReconciliationError(
      `chain-id mismatch: RPC=${chainId} expected=${config.chainId}`
    );
  }
  const code = await rpc.getCode(config.bamCoreAddress);
  if (code === '0x' || code === '0x0' || code === ('0x' as `0x${string}`)) {
    throw new StartupReconciliationError(
      `no contract code at bamCoreAddress ${config.bamCoreAddress} on chain ${chainId}`
    );
  }
}
