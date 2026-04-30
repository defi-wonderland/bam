import type { Address, Bytes32 } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import {
  BLOB_BATCH_REGISTERED_EVENT,
  BLOB_SEGMENT_DECLARED_EVENT,
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

interface FakeSegmentLog {
  blockNumber: bigint;
  transactionIndex: bigint;
  logIndex: bigint;
  transactionHash: Bytes32;
  args: {
    versionedHash: Bytes32;
    declarer: Address;
    startFE: number;
    endFE: number;
    contentTag: Bytes32;
  };
}

function fakeClient(
  rows: FakeLog[],
  segmentRows: FakeSegmentLog[] = []
): LogScanClient & {
  lastArgs?: unknown;
  calls: Array<{ from: number; to: number }>;
} {
  const client = {
    lastArgs: undefined as unknown,
    calls: [] as Array<{ from: number; to: number }>,
    async getLogs(args: Parameters<LogScanClient['getLogs']>[0]) {
      this.lastArgs = args;
      const fromBlock = Number(args.fromBlock);
      const toBlock = Number(args.toBlock);
      this.calls.push({ from: fromBlock, to: toBlock });
      const wantedTags = (args.args?.contentTag ?? []) as Bytes32[];
      const inRange = <T extends { blockNumber: bigint; args: { contentTag: Bytes32 } }>(
        r: T
      ): boolean =>
        Number(r.blockNumber) >= fromBlock &&
        Number(r.blockNumber) <= toBlock &&
        (wantedTags.length === 0 || wantedTags.includes(r.args.contentTag));
      const batchOut = rows.filter(inRange).map((r) => ({
        eventName: 'BlobBatchRegistered' as const,
        blockNumber: r.blockNumber,
        transactionIndex: r.transactionIndex,
        logIndex: r.logIndex,
        transactionHash: r.transactionHash,
        args: r.args,
      }));
      const segmentOut = segmentRows.filter(inRange).map((r) => ({
        eventName: 'BlobSegmentDeclared' as const,
        blockNumber: r.blockNumber,
        transactionIndex: r.transactionIndex,
        logIndex: r.logIndex,
        transactionHash: r.transactionHash,
        args: r.args,
      }));
      return [...batchOut, ...segmentOut];
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

  it('forwards both event ABIs on the publicClient call (one combined eth_getLogs)', async () => {
    const client = fakeClient([]);
    await scanLogs({
      publicClient: client,
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 0,
    });
    const args = client.lastArgs as Record<string, unknown>;
    expect(args.address).toBe(BAM_CORE);
    expect(args.events).toEqual([
      BLOB_BATCH_REGISTERED_EVENT,
      BLOB_SEGMENT_DECLARED_EVENT,
    ]);
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
    // No halving: the scanner fires one combined `getLogs` per range
    // and propagates the first non-family error directly.
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
    // No halving: exactly one combined `getLogs` call before the throw.
    expect(calls).toBe(1);
  });

  it('joins BlobSegmentDeclared events onto BlobBatchRegistered by (txHash, contentTag)', async () => {
    // Packed tx: one txHash, two per-tag entries with non-overlapping ranges.
    const PACKED_TX = ('0x' + 'cc'.repeat(32)) as Bytes32;
    const PACKED_BLOCK = 200;
    const VH = ('0x01' + 'cc'.repeat(31)) as Bytes32;
    const batchRows: FakeLog[] = [
      {
        blockNumber: BigInt(PACKED_BLOCK),
        transactionIndex: 0n,
        logIndex: 1n, // segment events come first per the contract
        transactionHash: PACKED_TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
      {
        blockNumber: BigInt(PACKED_BLOCK),
        transactionIndex: 0n,
        logIndex: 3n,
        transactionHash: PACKED_TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_B,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
    ];
    const segmentRows: FakeSegmentLog[] = [
      {
        blockNumber: BigInt(PACKED_BLOCK),
        transactionIndex: 0n,
        logIndex: 0n,
        transactionHash: PACKED_TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 0,
          endFE: 100,
          contentTag: TAG_A,
        },
      },
      {
        blockNumber: BigInt(PACKED_BLOCK),
        transactionIndex: 0n,
        logIndex: 2n,
        transactionHash: PACKED_TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 100,
          endFE: 250,
          contentTag: TAG_B,
        },
      },
    ];
    const out = await scanLogs({
      publicClient: fakeClient(batchRows, segmentRows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 100,
      toBlock: 300,
    });
    expect(out).toHaveLength(2);
    const a = out.find((e) => e.contentTag === TAG_A)!;
    const b = out.find((e) => e.contentTag === TAG_B)!;
    expect(a.startFE).toBe(0);
    expect(a.endFE).toBe(100);
    expect(b.startFE).toBe(100);
    expect(b.endFE).toBe(250);
  });

  it('positional pairing: rogue leading BSD does not steal the legit pair', async () => {
    // Hostile scenario: the same tx contains a bare `declareBlobSegment`
    // call (rogue BSD, logIndex=0) followed by a real
    // `registerBlobBatch` (legitimate BSD→BBR pair, logIndex=1,2). A
    // content-keyed last-wins join would attribute the rogue range to
    // the BBR. Positional LIFO pairing claims the legit BSD first;
    // the rogue BSD is left unconsumed and ignored.
    const TX = ('0x' + 'dd'.repeat(32)) as Bytes32;
    const VH = ('0x01' + 'dd'.repeat(31)) as Bytes32;
    const batchRows: FakeLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 2n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
    ];
    const segmentRows: FakeSegmentLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 0n, // rogue, emitted FIRST in tx
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 200,
          endFE: 300,
          contentTag: TAG_A,
        },
      },
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 1n, // legit, emitted right before BBR
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 0,
          endFE: 100,
          contentTag: TAG_A,
        },
      },
    ];
    const out = await scanLogs({
      publicClient: fakeClient(batchRows, segmentRows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 200,
    });
    expect(out).toHaveLength(1);
    // BBR pairs with the most-recent matching BSD (logIndex=1, range
    // 0..100), NOT the rogue BSD (logIndex=0, range 200..300).
    expect(out[0].startFE).toBe(0);
    expect(out[0].endFE).toBe(100);
  });

  it('positional pairing: same tag duplicated in one packed call → each BBR claims its own BSD', async () => {
    // registerBlobBatches([{tagA, 0..100}, {tagA, 100..250}]) emits:
    //   logIndex=0: BSD_A1 (0..100)
    //   logIndex=1: BBR_A1
    //   logIndex=2: BSD_A2 (100..250)
    //   logIndex=3: BBR_A2
    // Both BBRs share (txHash, contentTag); LIFO pairing claims the
    // matching BSD by recency.
    const TX = ('0x' + 'ee'.repeat(32)) as Bytes32;
    const VH = ('0x01' + 'ee'.repeat(31)) as Bytes32;
    const batchRows: FakeLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 1n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 3n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
    ];
    const segmentRows: FakeSegmentLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 0n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 0,
          endFE: 100,
          contentTag: TAG_A,
        },
      },
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 2n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 100,
          endFE: 250,
          contentTag: TAG_A,
        },
      },
    ];
    const out = await scanLogs({
      publicClient: fakeClient(batchRows, segmentRows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 200,
    });
    expect(out).toHaveLength(2);
    // First BBR (logIndex=1) gets BSD at logIndex=0 (range 0..100).
    // Second BBR (logIndex=3) gets BSD at logIndex=2 (range 100..250).
    const sorted = [...out].sort((a, b) => a.logIndex - b.logIndex);
    expect(sorted[0].startFE).toBe(0);
    expect(sorted[0].endFE).toBe(100);
    expect(sorted[1].startFE).toBe(100);
    expect(sorted[1].endFE).toBe(250);
  });

  it('positional pairing: trailing rogue BSD with no matching BBR is ignored', async () => {
    const TX = ('0x' + 'ff'.repeat(32)) as Bytes32;
    const VH = ('0x01' + 'ff'.repeat(31)) as Bytes32;
    const batchRows: FakeLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 1n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
    ];
    const segmentRows: FakeSegmentLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 0n,
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 0,
          endFE: 100,
          contentTag: TAG_A,
        },
      },
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 2n, // trailing rogue, after the BBR
        transactionHash: TX,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 500,
          endFE: 700,
          contentTag: TAG_A,
        },
      },
    ];
    const out = await scanLogs({
      publicClient: fakeClient(batchRows, segmentRows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 200,
    });
    expect(out).toHaveLength(1);
    expect(out[0].startFE).toBe(0);
    expect(out[0].endFE).toBe(100);
  });

  it('positional pairing: BSDs in tx X never pair with BBRs in tx Y', async () => {
    const TX_X = ('0x' + 'aa'.repeat(32)) as Bytes32;
    const TX_Y = ('0x' + 'bb'.repeat(32)) as Bytes32;
    const VH = ('0x01' + 'cc'.repeat(31)) as Bytes32;
    // BBR in tx_Y but its only matching BSD is in tx_X.
    const batchRows: FakeLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 1n,
        logIndex: 0n,
        transactionHash: TX_Y,
        args: {
          versionedHash: VH,
          submitter: SUBMITTER,
          contentTag: TAG_A,
          decoder: '0x0000000000000000000000000000000000000000' as Address,
          signatureRegistry: '0x0000000000000000000000000000000000000000' as Address,
        },
      },
    ];
    const segmentRows: FakeSegmentLog[] = [
      {
        blockNumber: 100n,
        transactionIndex: 0n,
        logIndex: 0n,
        transactionHash: TX_X,
        args: {
          versionedHash: VH,
          declarer: SUBMITTER,
          startFE: 0,
          endFE: 100,
          contentTag: TAG_A,
        },
      },
    ];
    const out = await scanLogs({
      publicClient: fakeClient(batchRows, segmentRows),
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 200,
    });
    expect(out).toHaveLength(1);
    // No matching BSD inside TX_Y → fall back to full-blob default.
    expect(out[0].startFE).toBe(0);
    expect(out[0].endFE).toBe(4096);
  });

  it('falls back to full-blob range when no matching segment event is observed', async () => {
    // Pre-feature on-chain history: BBR present, no BSD. Reader must
    // still return the event with the legacy full-blob default range
    // so single-segment decode keeps working.
    const out = await scanLogs({
      publicClient: fakeClient([fakeLog({ block: 50, tx: 0, log: 0, tag: TAG_A })]),
      bamCoreAddress: BAM_CORE,
      fromBlock: 0,
      toBlock: 100,
    });
    expect(out).toHaveLength(1);
    expect(out[0].startFE).toBe(0);
    expect(out[0].endFE).toBe(4096);
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
