import type { Address, Bytes32 } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import {
  BLOB_BATCH_REGISTERED_EVENT,
  MIN_CHUNK_BLOCKS,
  scanLogs,
  type LogScanClient,
} from '../../src/discovery/log-scan.js';

const BAM_CORE = '0x000000000000000000000000000000000000c07e' as Address;
const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const SUBMITTER = '0x000000000000000000000000000000000000ab12' as Address;

interface FakeLog {
  blockNumber: bigint;
  transactionIndex: bigint;
  logIndex: bigint;
  transactionHash: Bytes32;
  args: {
    versionedHash: Bytes32;
    submitter: Address;
    contentTag: Bytes32;
    decoder: Address;
    signatureRegistry: Address;
  };
}

function fakeLog(opts: {
  block: number;
  tx: number;
  log: number;
  tag: Bytes32;
}): FakeLog {
  const versionedHash =
    ('0x01' + opts.block.toString(16).padStart(2, '0').repeat(31)) as Bytes32;
  const txHash = ('0x' + opts.block.toString(16).padStart(2, '0').repeat(32)) as Bytes32;
  return {
    blockNumber: BigInt(opts.block),
    transactionIndex: BigInt(opts.tx),
    logIndex: BigInt(opts.log),
    transactionHash: txHash,
    args: {
      versionedHash,
      submitter: SUBMITTER,
      contentTag: opts.tag,
      decoder: '0x0000000000000000000000000000000000000000' as Address,
      signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
    },
  };
}

function fakeClient(
  rows: FakeLog[]
): LogScanClient & { lastArgs?: unknown; calls: Array<{ from: number; to: number }> } {
  const client = {
    lastArgs: undefined as unknown,
    calls: [] as Array<{ from: number; to: number }>,
    async getLogs(args: Parameters<LogScanClient['getLogs']>[0]) {
      this.lastArgs = args;
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      this.calls.push({ from: fromBlock, to: toBlock });
      const wantedTags = (args.args?.contentTag ?? []) as Bytes32[];
      return rows
        .filter(
          (r) =>
            Number(r.blockNumber) >= fromBlock &&
            Number(r.blockNumber) <= toBlock &&
            (wantedTags.length === 0 || wantedTags.includes(r.args.contentTag))
        )
        .map((r) => ({
          blockNumber: r.blockNumber,
          transactionIndex: r.transactionIndex,
          logIndex: r.logIndex,
          transactionHash: r.transactionHash,
          args: r.args,
        }));
    },
  };
  return client;
}

describe('scanLogs', () => {
  it('returns an empty array on an empty block range', async () => {
    const client = fakeClient([fakeLog({ block: 5, tx: 0, log: 0, tag: TAG_A })]);
    const out = await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 99,
    });
    expect(out).toEqual([]);
  });

  it('orders events canonically by (blockNumber, logIndex) across multiple blocks', async () => {
    const rows = [
      fakeLog({ block: 11, tx: 0, log: 4, tag: TAG_A }),
      fakeLog({ block: 10, tx: 1, log: 9, tag: TAG_B }),
      fakeLog({ block: 10, tx: 0, log: 1, tag: TAG_A }),
      fakeLog({ block: 12, tx: 0, log: 0, tag: TAG_A }),
    ];
    const out = await scanLogs({
      publicClient: fakeClient(rows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 10,
      toBlock: 12,
    });
    expect(out.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [10, 1],
      [10, 9],
      [11, 4],
      [12, 0],
    ]);
  });

  it('filters by contentTag when an allowlist is provided', async () => {
    const rows = [
      fakeLog({ block: 100, tx: 0, log: 0, tag: TAG_A }),
      fakeLog({ block: 101, tx: 0, log: 0, tag: TAG_B }),
      fakeLog({ block: 102, tx: 0, log: 0, tag: TAG_A }),
    ];
    const client = fakeClient(rows);
    const out = await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 200,
      contentTags: [TAG_A],
    });
    expect(out.map((e) => e.contentTag)).toEqual([TAG_A, TAG_A]);
    // Confirm the allowlist is forwarded to getLogs (not post-filtered).
    expect((client.lastArgs as { args?: { contentTag?: readonly Bytes32[] } }).args).toEqual({
      contentTag: [TAG_A],
    });
  });

  it('treats an empty allowlist as no filter', async () => {
    const rows = [fakeLog({ block: 5, tx: 0, log: 0, tag: TAG_A })];
    const client = fakeClient(rows);
    await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 100,
      contentTags: [],
    });
    expect(
      (client.lastArgs as { args?: unknown }).args
    ).toBeUndefined();
  });

  it('forwards the canonical event shape on the publicClient call', async () => {
    const client = fakeClient([]);
    await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 0,
    });
    const args = client.lastArgs as Record<string, unknown>;
    expect(args.address).toBe(BAM_CORE);
    expect(args.event).toBe(BLOB_BATCH_REGISTERED_EVENT);
    expect(args.fromBlock).toBe(0n);
    expect(args.toBlock).toBe(0n);
  });

  it('issues exactly one getLogs call when the range fits in one chunk (G-7)', async () => {
    const client = fakeClient([fakeLog({ block: 105, tx: 0, log: 0, tag: TAG_A })]);
    const out = await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 110,
      chunkSize: 100,
    });
    expect(client.calls).toEqual([{ from: 100, to: 110 }]);
    expect(out.map((e) => e.blockNumber)).toEqual([105]);
  });

  it('returns the same row set under chunk halving as a single-call control (G-5)', async () => {
    const rows = [
      fakeLog({ block: 110, tx: 0, log: 0, tag: TAG_A }),
      fakeLog({ block: 145, tx: 0, log: 1, tag: TAG_B }),
      fakeLog({ block: 220, tx: 0, log: 0, tag: TAG_A }),
      fakeLog({ block: 280, tx: 1, log: 0, tag: TAG_A }),
    ];
    const fakeWithCap = (cap: number): LogScanClient & {
      calls: Array<{ from: number; to: number }>;
    } => {
      const base = fakeClient(rows);
      return {
        calls: base.calls,
        async getLogs(args) {
          const span = Number(args.toBlock) - Number(args.fromBlock) + 1;
          if (span > cap) {
            throw new Error('Block range is too large');
          }
          return base.getLogs(args);
        },
      };
    };

    const control = await scanLogs({
      publicClient: fakeClient(rows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 299,
    });
    const halved = await scanLogs({
      publicClient: fakeWithCap(150),
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 299,
    });
    expect(halved.map((e) => [e.blockNumber, e.logIndex])).toEqual(
      control.map((e) => [e.blockNumber, e.logIndex])
    );
  });

  it('rethrows the family error after halving down to MIN_CHUNK_BLOCKS (G-6)', async () => {
    const alwaysFails: LogScanClient = {
      async getLogs() {
        throw new Error('Log response size exceeded');
      },
    };
    await expect(
      scanLogs({
        publicClient: alwaysFails,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: MIN_CHUNK_BLOCKS * 4,
      })
    ).rejects.toThrow(/log response size exceeded/i);
  });

  it('rethrows non-matching errors immediately without halving', async () => {
    let calls = 0;
    const generic: LogScanClient = {
      async getLogs() {
        calls += 1;
        throw new Error('connection reset by peer');
      },
    };
    await expect(
      scanLogs({
        publicClient: generic,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 10_000,
      })
    ).rejects.toThrow(/connection reset/);
    expect(calls).toBe(1);
  });

  it('rejects a non-integer chunkSize with TypeError (boundary validation)', async () => {
    const client = fakeClient([]);
    await expect(
      scanLogs({
        publicClient: client,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 100,
        chunkSize: 1.5,
      })
    ).rejects.toBeInstanceOf(TypeError);
    // Critically, no getLogs call is issued before validation.
    expect(client.calls.length).toBe(0);
  });

  it('rejects chunkSize = 0 and negative chunkSize', async () => {
    const client = fakeClient([]);
    for (const bad of [0, -1, -100]) {
      await expect(
        scanLogs({
          publicClient: client,
          bamCoreAddress: BAM_CORE,
          fromBlock: 0,
          toBlock: 100,
          chunkSize: bad,
        })
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('does not halve on `exceeds the gas limit` (eth_call family, not range)', async () => {
    // Regression guard: an earlier `/exceeds the.*limit/i` pattern would
    // have matched legitimate eth_call gas-limit errors and triggered
    // halving for an unrelated error class.
    let calls = 0;
    const gasErr: LogScanClient = {
      async getLogs() {
        calls += 1;
        throw new Error('execution reverted: exceeds the gas limit');
      },
    };
    await expect(
      scanLogs({
        publicClient: gasErr,
        bamCoreAddress: BAM_CORE,
        fromBlock: 0,
        toBlock: 10_000,
      })
    ).rejects.toThrow(/exceeds the gas limit/);
    expect(calls).toBe(1);
  });

  it('pages a multi-chunk range and returns the union in canonical order', async () => {
    const rows = [
      fakeLog({ block: 350, tx: 0, log: 1, tag: TAG_A }),
      fakeLog({ block: 102, tx: 0, log: 0, tag: TAG_A }),
      fakeLog({ block: 250, tx: 0, log: 0, tag: TAG_B }),
    ];
    const client = fakeClient(rows);
    const out = await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 399,
      chunkSize: 100,
    });
    expect(client.calls).toEqual([
      { from: 100, to: 199 },
      { from: 200, to: 299 },
      { from: 300, to: 399 },
    ]);
    expect(out.map((e) => e.blockNumber)).toEqual([102, 250, 350]);
  });
});
