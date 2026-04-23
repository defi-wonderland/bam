import { describe, it, expect } from 'vitest';
import type { Address } from 'bam-sdk';

import {
  StartupReconciliationError,
  reconcileStartup,
  type ReconcileRpcClient,
} from '../../src/startup/reconcile.js';

const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

describe('reconcileStartup', () => {
  it('passes when chain-id matches and contract code is non-empty', async () => {
    const rpc: ReconcileRpcClient = {
      async getChainId() {
        return 11155111;
      },
      async getCode() {
        return '0x6080604052' as `0x${string}`;
      },
    };
    await expect(
      reconcileStartup(rpc, { chainId: 11155111, bamCoreAddress: BAM_CORE })
    ).resolves.toBeUndefined();
  });

  it('throws on chain-id mismatch', async () => {
    const rpc: ReconcileRpcClient = {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x1234' as `0x${string}`;
      },
    };
    await expect(
      reconcileStartup(rpc, { chainId: 11155111, bamCoreAddress: BAM_CORE })
    ).rejects.toBeInstanceOf(StartupReconciliationError);
  });

  it('throws when the contract has no code at the address', async () => {
    const rpc: ReconcileRpcClient = {
      async getChainId() {
        return 11155111;
      },
      async getCode() {
        return '0x' as `0x${string}`;
      },
    };
    await expect(
      reconcileStartup(rpc, { chainId: 11155111, bamCoreAddress: BAM_CORE })
    ).rejects.toBeInstanceOf(StartupReconciliationError);
  });
});
