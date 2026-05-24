import { describe, expect, it } from 'vitest';

import { getDeployment } from '../../src/contracts/deployments.js';

describe('deployments registry', () => {
  it('returns the Sepolia BAM Core deploy block', () => {
    const sepolia = getDeployment(11155111);
    expect(sepolia).toBeDefined();
    const core = sepolia?.contracts.BlobAuthenticatedMessagingCore;
    expect(core?.address).toBe('0xC572A7F6dba1f3cB666b14d357671903685BeDdb');
    expect(core?.deployBlock).toBe(10912245);
  });

  it('returns undefined for an unknown chainId', () => {
    expect(getDeployment(999_999)).toBeUndefined();
  });
});
