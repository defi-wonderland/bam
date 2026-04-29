import { describe, expect, it } from 'vitest';

import { getDeployment } from '../../src/contracts/deployments.js';

describe('deployments registry', () => {
  it('returns the Sepolia BAM Core deploy block', () => {
    const sepolia = getDeployment(11155111);
    expect(sepolia).toBeDefined();
    const core = sepolia?.contracts.BlobAuthenticatedMessagingCore;
    expect(core?.address).toBe('0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314');
    expect(core?.deployBlock).toBe(10697923);
  });

  it('returns undefined for an unknown chainId', () => {
    expect(getDeployment(999_999)).toBeUndefined();
  });
});
