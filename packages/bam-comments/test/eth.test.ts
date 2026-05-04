import { describe, it, expect, beforeEach } from 'vitest';

import {
  WalletError,
  mapProviderError,
  normalizeEcdsaV,
  onAccountsChanged,
  readExistingAccount,
  requireProvider,
  requestAccount,
  signTypedData,
  type Eip1193Provider,
} from '../src/eth.js';

function stub(impl: (m: string, p?: unknown[]) => Promise<unknown>): Eip1193Provider {
  return {
    request: ({ method, params }) => impl(method, params),
  };
}

describe('mapProviderError', () => {
  it('maps 4001 → request_rejected', () => {
    const err = mapProviderError({ code: 4001, message: 'user denied' });
    expect(err.code).toBe('request_rejected');
  });

  it('maps 4900 → disconnected', () => {
    expect(mapProviderError({ code: 4900 }).code).toBe('disconnected');
  });

  it('maps 4901 → disconnected', () => {
    expect(mapProviderError({ code: 4901 }).code).toBe('disconnected');
  });

  it('maps 4200 → unsupported_method', () => {
    expect(mapProviderError({ code: 4200 }).code).toBe('unsupported_method');
  });

  it('maps unknown code → unknown', () => {
    expect(mapProviderError({ code: 9999 }).code).toBe('unknown');
  });

  it('non-object input → unknown', () => {
    expect(mapProviderError(null).code).toBe('unknown');
    expect(mapProviderError(undefined).code).toBe('unknown');
    expect(mapProviderError('boom').code).toBe('unknown');
  });
});

describe('normalizeEcdsaV', () => {
  it('rewrites 0x00 → 0x1b', () => {
    const sig = ('0x' + 'aa'.repeat(64) + '00') as `0x${string}`;
    const out = normalizeEcdsaV(sig);
    expect(out.endsWith('1b')).toBe(true);
  });

  it('rewrites 0x01 → 0x1c', () => {
    const sig = ('0x' + 'aa'.repeat(64) + '01') as `0x${string}`;
    const out = normalizeEcdsaV(sig);
    expect(out.endsWith('1c')).toBe(true);
  });

  it('passes through 0x1b unchanged', () => {
    const sig = ('0x' + 'bb'.repeat(64) + '1b') as `0x${string}`;
    expect(normalizeEcdsaV(sig)).toBe(sig);
  });

  it('passes through 0x1c unchanged', () => {
    const sig = ('0x' + 'cc'.repeat(64) + '1c') as `0x${string}`;
    expect(normalizeEcdsaV(sig)).toBe(sig);
  });

  it('throws bad_signature_shape on non-65-byte length', () => {
    expect(() => normalizeEcdsaV('0xdead' as `0x${string}`)).toThrow(WalletError);
  });

  it('throws bad_signature_shape on non-canonical v byte', () => {
    const sig = ('0x' + 'aa'.repeat(64) + '42') as `0x${string}`;
    expect(() => normalizeEcdsaV(sig)).toThrow(/non-canonical v byte/);
  });
});

describe('requireProvider', () => {
  beforeEach(() => {
    delete (globalThis as { window?: { ethereum?: Eip1193Provider } }).window;
  });

  it('throws wallet_not_installed when window.ethereum is missing', () => {
    (globalThis as { window?: object }).window = {};
    let caught: unknown;
    try {
      requireProvider();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WalletError);
    expect((caught as WalletError).code).toBe('wallet_not_installed');
  });

  it('returns the provider when present', () => {
    const provider = stub(async () => '0xaa36a7');
    (globalThis as { window?: object }).window = { ethereum: provider };
    expect(requireProvider()).toBe(provider);
  });
});

describe('requestAccount', () => {
  it('returns the first account, lowercased', async () => {
    const provider = stub(async () => ['0xABCDEF0000000000000000000000000000000001']);
    const acc = await requestAccount(provider);
    expect(acc).toBe('0xabcdef0000000000000000000000000000000001');
  });

  it('throws disconnected on empty array', async () => {
    const provider = stub(async () => []);
    await expect(requestAccount(provider)).rejects.toMatchObject({
      code: 'disconnected',
    });
  });

  it('maps 4001 (user rejected) to request_rejected', async () => {
    const provider = stub(async () => {
      throw { code: 4001, message: 'user denied' };
    });
    await expect(requestAccount(provider)).rejects.toMatchObject({
      code: 'request_rejected',
    });
  });
});

describe('signTypedData', () => {
  const account = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const td = {
    domain: { name: 'BAM' as const, version: '1' as const, chainId: 11155111 },
    types: { BAMMessage: [] },
    primaryType: 'BAMMessage' as const,
    message: { sender: account, nonce: 0n, contents: '0x' as `0x${string}` },
  };

  it('returns a v-normalised 65-byte signature', async () => {
    const provider = stub(async (method) => {
      expect(method).toBe('eth_signTypedData_v4');
      return '0x' + 'aa'.repeat(64) + '00';
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await signTypedData(provider, account, td as any);
    expect(sig.endsWith('1b')).toBe(true);
  });

  it('throws bad_signature_shape on non-string return', async () => {
    const provider = stub(async () => 42);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData(provider, account, td as any)
    ).rejects.toMatchObject({ code: 'bad_signature_shape' });
  });

  it('throws bad_signature_shape on truncated hex', async () => {
    const provider = stub(async () => '0xdead');
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData(provider, account, td as any)
    ).rejects.toMatchObject({ code: 'bad_signature_shape' });
  });

  it('throws bad_signature_shape on non-hex characters in payload', async () => {
    const provider = stub(async () => '0x' + 'zz'.repeat(65));
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData(provider, account, td as any)
    ).rejects.toMatchObject({ code: 'bad_signature_shape' });
  });

  it('maps user rejection (4001) to request_rejected', async () => {
    const provider = stub(async () => {
      throw { code: 4001, message: 'denied' };
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData(provider, account, td as any)
    ).rejects.toMatchObject({ code: 'request_rejected' });
  });
});

describe('onAccountsChanged', () => {
  function eventfulStub(): {
    provider: Eip1193Provider;
    fire: (accounts: unknown) => void;
    listeners: number;
  } {
    const handlers: ((...args: unknown[]) => void)[] = [];
    const provider: Eip1193Provider = {
      request: async () => undefined,
      on: (_evt, handler) => {
        handlers.push(handler);
      },
      removeListener: (_evt, handler) => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      },
    };
    return {
      provider,
      fire: (accounts) => handlers.forEach((h) => h(accounts)),
      get listeners() {
        return handlers.length;
      },
    };
  }

  it('reports the first account, lowercased, as Hex', () => {
    const { provider, fire } = eventfulStub();
    let received: `0x${string}` | null | undefined;
    onAccountsChanged(provider, (a) => {
      received = a;
    });
    fire(['0xABCDEF0000000000000000000000000000000001']);
    expect(received).toBe('0xabcdef0000000000000000000000000000000001');
  });

  it('reports null on empty array (disconnect)', () => {
    const { provider, fire } = eventfulStub();
    let received: `0x${string}` | null | undefined = '0xseed' as never;
    onAccountsChanged(provider, (a) => {
      received = a;
    });
    fire([]);
    expect(received).toBeNull();
  });

  it('cleanup removes the listener', () => {
    const stub = eventfulStub();
    const off = onAccountsChanged(stub.provider, () => {});
    expect(stub.listeners).toBe(1);
    off();
    expect(stub.listeners).toBe(0);
  });

  it('returns a no-op cleanup when provider has no on()', () => {
    const provider: Eip1193Provider = { request: async () => undefined };
    const off = onAccountsChanged(provider, () => {});
    expect(off).not.toThrow;
    off(); // must not throw
  });
});

describe('readExistingAccount', () => {
  it('returns the lowercased first account when wallet remembers a connection', async () => {
    const provider = stub(async (method) => {
      expect(method).toBe('eth_accounts');
      return ['0xABCDEF0000000000000000000000000000000001'];
    });
    expect(await readExistingAccount(provider)).toBe(
      '0xabcdef0000000000000000000000000000000001'
    );
  });

  it('returns null on empty array (no remembered connection)', async () => {
    const provider = stub(async () => []);
    expect(await readExistingAccount(provider)).toBeNull();
  });

  it('returns null when the request rejects (does not propagate)', async () => {
    const provider = stub(async () => {
      throw { code: 4100, message: 'unauth' };
    });
    expect(await readExistingAccount(provider)).toBeNull();
  });
});
