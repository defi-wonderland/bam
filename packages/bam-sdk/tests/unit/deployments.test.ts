import { describe, expect, it } from 'vitest';

import { getDeployment } from '../../src/contracts/deployments.js';

describe('deployments registry', () => {
  it('returns the Sepolia BAM Core deploy block', () => {
    const sepolia = getDeployment(11155111);
    expect(sepolia).toBeDefined();
    const core = sepolia?.contracts.BlobAuthenticatedMessagingCore;
    expect(core?.address).toBe('0xAC01D2d2E8016a14eb2b4bd318ae221f866B9725');
    expect(core?.deployBlock).toBe(10764769);
  });

  it('returns undefined for an unknown chainId', () => {
    expect(getDeployment(999_999)).toBeUndefined();
  });
});
