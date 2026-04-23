import { describe, it, expect, beforeEach } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  deriveAddress,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';

import {
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
  defaultBatchPolicy,
} from '../src/index.js';
import type { BuildAndSubmit, PosterFactoryExtras } from '../src/index.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

function makeRpcOk(): PosterFactoryExtras['rpc'] {
  return {
    async getChainId() {
      return 1;
    },
    async getCode() {
      return '0x6080' as `0x${string}`;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async getBlockNumber() {
      return 100n;
    },
    async getTransactionBlock() {
      return 100;
    },
  };
}

const buildAndSubmit: BuildAndSubmit = async () => ({
  kind: 'included',
  txHash: ('0x' + '11'.repeat(32)) as Bytes32,
  blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
  blockNumber: 100,
});

async function signedRaw(content = 'hello'): Promise<Uint8Array> {
  const pk = generateECDSAPrivateKey();
  const author = deriveAddress(pk);
  const timestamp = 1_700_000_000;
  const nonce = 1;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  const env = {
    contentTag: TAG,
    message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

describe('createPoster — happy path', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('constructs with valid config + rpc + sign in a message', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + 'ab'.repeat(32)) as unknown) as `0x${string}`
    );
    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
      },
      { buildAndSubmit, rpc: makeRpcOk() }
    );
    expect(await poster.health()).toEqual({ state: 'ok' });
    const raw = await signedRaw();
    const res = await poster.submit(raw);
    expect(res.accepted).toBe(true);
    const pending = await poster.listPending({ contentTag: TAG });
    expect(pending).toHaveLength(1);
    await poster.stop();
  });
});

describe('createPoster — duplicate-signer-in-process (plan §C-10)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('throws when two Posters share the same signer address', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + 'cd'.repeat(32)) as unknown) as `0x${string}`
    );
    const one = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
      },
      { buildAndSubmit, rpc: makeRpcOk() }
    );
    await expect(
      createPoster(
        {
          allowlistedTags: [TAG],
          chainId: 1,
          bamCoreAddress: BAM_CORE,
          signer,
          store: createMemoryStore(),
        },
        { buildAndSubmit, rpc: makeRpcOk() }
      )
    ).rejects.toThrow(/already configured/);
    await one.stop();
  });

  it('releases the signer slot on stop so re-creation is allowed', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + 'ef'.repeat(32)) as unknown) as `0x${string}`
    );
    const first = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
      },
      { buildAndSubmit, rpc: makeRpcOk() }
    );
    await first.stop();
    // Re-create — same signer, should succeed.
    const second = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
      },
      { buildAndSubmit, rpc: makeRpcOk() }
    );
    await second.stop();
  });
});

describe('createPoster — health().since latching (cubic review)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('latches non-ok epoch start; repeated calls return the same `since`', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + '03'.repeat(32)) as unknown) as `0x${string}`
    );
    // Controllable clock: every call to `now()` returns whatever the
    // test last set. Lets us assert that `since` was latched at the
    // *first* non-ok observation and does not drift.
    let clock = new Date('2026-01-01T00:00:00Z');
    const now = (): Date => clock;

    // Sink always reports an included tx so the happy path can flip
    // the loop back to ok. Overridden below for the failure phase.
    let shouldFail = false;
    const failingBuildAndSubmit: BuildAndSubmit = async () => {
      if (shouldFail) {
        return { kind: 'retryable', detail: 'simulated RPC blip' };
      }
      return {
        kind: 'included',
        txHash: ('0x' + '11'.repeat(32)) as Bytes32,
        blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
        blockNumber: 100,
      };
    };

    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
        now,
        // Trip to degraded on the first failure so the test doesn't
        // need to drive 5 ticks just to set up the assertion.
        backoff: {
          baseMs: 1,
          capMs: 1,
          degradedAfterAttempts: 1,
          unhealthyAfterAttempts: 50,
        },
        // Force selection to fire on a single pending message so we
        // don't have to wait for size/age thresholds.
        batchPolicy: defaultBatchPolicy({ countTrigger: 1 }),
      },
      { buildAndSubmit: failingBuildAndSubmit, rpc: makeRpcOk() }
    );
    const internal = poster as unknown as {
      _tickTag: (t: Bytes32) => Promise<unknown>;
    };

    // Feed a pending message so the loop has something to submit.
    const raw = await signedRaw('first');
    expect((await poster.submit(raw)).accepted).toBe(true);

    // Phase 1: force a submission failure. Clock = T0.
    shouldFail = true;
    await internal._tickTag(TAG);
    expect((await poster.health()).state).toBe('degraded');

    const firstSince = (await poster.health()).since;
    expect(firstSince).toEqual(new Date('2026-01-01T00:00:00Z'));

    // Phase 2: time advances but we're still degraded. `since` must
    // be latched at T0, not re-computed to T1.
    clock = new Date('2026-01-01T00:05:00Z');
    const laterSince = (await poster.health()).since;
    expect(laterSince).toEqual(firstSince);

    // Phase 3: a successful tick clears the non-ok epoch; `since`
    // should disappear from the next `ok` health read.
    shouldFail = false;
    await internal._tickTag(TAG);
    const healthy = await poster.health();
    expect(healthy.state).toBe('ok');
    expect(healthy.since).toBeUndefined();

    await poster.stop();
  });
});

describe('createPoster — startup reconciliation (gate G-8)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('propagates a chain-id mismatch', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + '01'.repeat(32)) as unknown) as `0x${string}`
    );
    const rpc = {
      ...makeRpcOk(),
      async getChainId() {
        return 999;
      },
    };
    await expect(
      createPoster(
        {
          allowlistedTags: [TAG],
          chainId: 1,
          bamCoreAddress: BAM_CORE,
          signer,
          store: createMemoryStore(),
        },
        { buildAndSubmit, rpc }
      )
    ).rejects.toThrow(/chain-id mismatch/);
  });

  it('propagates missing bytecode', async () => {
    const signer = new LocalEcdsaSigner(
      (('0x' + '02'.repeat(32)) as unknown) as `0x${string}`
    );
    const rpc = {
      ...makeRpcOk(),
      async getCode() {
        return '0x' as `0x${string}`;
      },
    };
    await expect(
      createPoster(
        {
          allowlistedTags: [TAG],
          chainId: 1,
          bamCoreAddress: BAM_CORE,
          signer,
          store: createMemoryStore(),
        },
        { buildAndSubmit, rpc }
      )
    ).rejects.toThrow(/no contract code/);
  });
});
