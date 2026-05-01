/**
 * Behavior of `src/widget/eth.ts` against a stub EIP-1193
 * provider — no real `window.ethereum` involved.
 *
 * Covers: connect / accounts / chainId happy paths, the v-byte
 * normalization that mirrors bam-sdk, and the error mapping that
 * keeps raw provider strings off the caller surface.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';

import {
  __setEthereumProviderForTests,
  WalletError,
  connect,
  getChainId,
  getConnectedAddress,
  signTypedData,
} from '../src/widget/eth.js';
import { buildBamTypedData } from '../src/widget/typed-data.js';

interface StubProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function stub(handler: StubProvider['request']): StubProvider {
  return { request: handler };
}

afterEach(() => {
  __setEthereumProviderForTests(null);
});

describe('eth.ts — happy paths', () => {
  it('connect() returns the first account from eth_requestAccounts', async () => {
    __setEthereumProviderForTests(
      stub(async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          return ['0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe'];
        }
        throw new Error(`unexpected ${method}`);
      })
    );
    expect(await connect()).toBe(
      '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe'
    );
  });

  it('getConnectedAddress returns null when eth_accounts is empty', async () => {
    __setEthereumProviderForTests(
      stub(async ({ method }) => {
        if (method === 'eth_accounts') return [];
        throw new Error(`unexpected ${method}`);
      })
    );
    expect(await getConnectedAddress()).toBeNull();
  });

  it('getChainId parses hex chainId', async () => {
    __setEthereumProviderForTests(
      stub(async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7'; // Sepolia
        throw new Error(`unexpected ${method}`);
      })
    );
    expect(await getChainId()).toBe(11155111);
  });
});

describe('eth.ts — signTypedData', () => {
  const td = buildBamTypedData({
    sender: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
    nonce: 0n,
    contents: ('0x' + '00'.repeat(32)) as Hex,
    chainId: 11155111,
  });

  it('passes JSON-stringified typedData as params[1]', async () => {
    let captured: unknown[] | undefined;
    __setEthereumProviderForTests(
      stub(async ({ method, params }) => {
        if (method === 'eth_signTypedData_v4') {
          captured = params;
          // 65-byte signature with v=0x1c — already canonical.
          return '0x' + 'aa'.repeat(64) + '1c';
        }
        throw new Error(`unexpected ${method}`);
      })
    );
    await signTypedData({
      address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
      typedData: td,
    });
    expect(captured?.[0]).toBe('0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe');
    // params[1] is the JSON-stringified typed data; parse and
    // confirm primaryType made it through.
    expect(typeof captured?.[1]).toBe('string');
    const parsed = JSON.parse(captured?.[1] as string);
    expect(parsed.primaryType).toBe('BAMMessage');
    expect(parsed.types.EIP712Domain).toBeDefined();
  });

  it('normalizes v=0 → v=27', async () => {
    __setEthereumProviderForTests(
      stub(async () => '0x' + 'aa'.repeat(64) + '00')
    );
    const sig = await signTypedData({
      address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
      typedData: td,
    });
    expect(sig.slice(-2).toLowerCase()).toBe('1b'); // 27 == 0x1b
  });

  it('normalizes v=1 → v=28', async () => {
    __setEthereumProviderForTests(
      stub(async () => '0x' + 'aa'.repeat(64) + '01')
    );
    const sig = await signTypedData({
      address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
      typedData: td,
    });
    expect(sig.slice(-2).toLowerCase()).toBe('1c');
  });

  it('passes v=27 / v=28 through unchanged', async () => {
    __setEthereumProviderForTests(
      stub(async () => '0x' + 'aa'.repeat(64) + '1c')
    );
    const sig = await signTypedData({
      address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
      typedData: td,
    });
    expect(sig.slice(-2).toLowerCase()).toBe('1c');
  });

  it('rejects a non-65-byte signature', async () => {
    __setEthereumProviderForTests(stub(async () => '0xdeadbeef'));
    await expect(
      signTypedData({
        address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
        typedData: td,
      })
    ).rejects.toMatchObject({
      code: 'bad_signature_shape',
    } satisfies Partial<WalletError>);
  });

  it('rejects a non-canonical v byte (e.g. v=0x05)', async () => {
    __setEthereumProviderForTests(
      stub(async () => '0x' + 'aa'.repeat(64) + '05')
    );
    await expect(
      signTypedData({
        address: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' as Hex,
        typedData: td,
      })
    ).rejects.toMatchObject({ code: 'bad_signature_shape' });
  });
});

describe('eth.ts — error mapping', () => {
  it('maps EIP-1193 code 4001 to request_rejected', async () => {
    __setEthereumProviderForTests(
      stub(async () => {
        // Mimic MetaMask's user-rejection error shape.
        const e: { code: number; message: string } = {
          code: 4001,
          message: 'User rejected the request.',
        };
        throw e;
      })
    );
    await expect(connect()).rejects.toMatchObject({ code: 'request_rejected' });
  });

  it('maps EIP-1193 code 4900 to disconnected', async () => {
    __setEthereumProviderForTests(
      stub(async () => {
        const e: { code: number; message: string } = {
          code: 4900,
          message: 'disconnected',
        };
        throw e;
      })
    );
    await expect(connect()).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('maps an unknown numeric code to unknown', async () => {
    __setEthereumProviderForTests(
      stub(async () => {
        const e: { code: number; message: string } = {
          code: -32603,
          message: 'internal',
        };
        throw e;
      })
    );
    await expect(connect()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('maps a non-EIP-1193 throw to unknown', async () => {
    __setEthereumProviderForTests(
      stub(async () => {
        throw new Error('something happened');
      })
    );
    await expect(connect()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('throws wallet_not_installed when no provider is present', async () => {
    __setEthereumProviderForTests(null);
    // Make sure no real window.ethereum sneaks in (vitest node env).
    delete (globalThis as { ethereum?: unknown }).ethereum;
    await expect(connect()).rejects.toMatchObject({
      code: 'wallet_not_installed',
    });
  });
});
