'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BLOB_BYTES_USABLE,
  blobCost,
  calldataCost,
  weiToEth,
  weiToGwei,
  weiToUsd,
} from '@/lib/cost';

type FeeSnapshot = {
  latestBaseFeeWei: string;
  latestBlobBaseFeeWei: string;
  avgBaseFeeWei: string;
  avgBlobBaseFeeWei: string;
  blocks: number;
  fetchedAt: string;
  ethUsd: number | null;
  ethUsdSource: string;
  ethUsdFetchedAt: string | null;
};

type FeesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: FeeSnapshot };

export default function Page() {
  const [text, setText] = useState(
    'Hello blob world! Try pasting a few KB of text to see when blobs win.',
  );
  const [fees, setFees] = useState<FeesState>({ status: 'loading' });
  const [mode, setMode] = useState<'latest' | 'avg'>('avg');

  async function loadFees() {
    setFees({ status: 'loading' });
    try {
      const r = await fetch('/api/fees', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) {
        setFees({ status: 'error', message: j.error ?? `HTTP ${r.status}` });
        return;
      }
      setFees({ status: 'ok', data: j });
    } catch (e) {
      setFees({ status: 'error', message: (e as Error).message });
    }
  }

  useEffect(() => {
    loadFees();
  }, []);

  const bytes = useMemo(() => new TextEncoder().encode(text), [text]);

  const priced = useMemo(() => {
    if (fees.status !== 'ok') return null;
    const baseFee = BigInt(mode === 'avg' ? fees.data.avgBaseFeeWei : fees.data.latestBaseFeeWei);
    const blobFee = BigInt(
      mode === 'avg' ? fees.data.avgBlobBaseFeeWei : fees.data.latestBlobBaseFeeWei,
    );
    return {
      baseFee,
      blobFee,
      ethUsd: fees.data.ethUsd,
      calldata: calldataCost(bytes, baseFee),
      blob: blobCost(bytes.length, blobFee, baseFee),
    };
  }, [bytes, fees, mode]);

  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Blob vs calldata cost</h1>
        <p className="text-slate-600 text-sm mt-1">
          Enter a payload. We price it as both regular calldata (EIP-7623 floor included) and
          EIP-4844 blobs, using recent Ethereum mainnet fees.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-700">Recent fees</h2>
          <div className="flex items-center gap-2">
            <fieldset className="flex text-xs rounded border border-slate-200 overflow-hidden">
              <label className={tabCls(mode === 'avg')}>
                <input
                  type="radio"
                  name="mode"
                  value="avg"
                  checked={mode === 'avg'}
                  onChange={() => setMode('avg')}
                  className="sr-only"
                />
                Avg
              </label>
              <label className={tabCls(mode === 'latest')}>
                <input
                  type="radio"
                  name="mode"
                  value="latest"
                  checked={mode === 'latest'}
                  onChange={() => setMode('latest')}
                  className="sr-only"
                />
                Latest
              </label>
            </fieldset>
            <button
              type="button"
              onClick={loadFees}
              className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-100"
            >
              Refresh
            </button>
          </div>
        </div>

        {fees.status === 'loading' && (
          <p className="text-sm text-slate-500">Loading fee history…</p>
        )}
        {fees.status === 'error' && (
          <p className="text-sm text-red-600">Failed to load fees: {fees.message}</p>
        )}
        {fees.status === 'ok' && priced && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm font-mono">
            <dt className="text-slate-500">Base fee</dt>
            <dd>{weiToGwei(priced.baseFee)} gwei</dd>
            <dt className="text-slate-500">Blob base fee</dt>
            <dd>{weiToGwei(priced.blobFee)} gwei</dd>
            <dt className="text-slate-500">ETH / USD</dt>
            <dd>
              {priced.ethUsd !== null
                ? `$${priced.ethUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                : '—'}
            </dd>
            <dt className="text-slate-500 col-span-2 text-[11px] pt-1">
              {mode === 'avg' ? `Averaged over ${fees.data.blocks} blocks` : 'Latest block'} ·
              fetched {new Date(fees.data.fetchedAt).toLocaleTimeString()} · price{' '}
              {fees.data.ethUsdSource}
            </dt>
          </dl>
        )}
      </section>

      <section className="space-y-2">
        <label htmlFor="payload" className="block text-sm font-medium text-slate-700">
          Payload (UTF-8)
        </label>
        <textarea
          id="payload"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className="w-full font-mono text-sm rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:ring-0"
          placeholder="Type or paste anything…"
        />
        <p className="text-xs text-slate-500">
          {bytes.length.toLocaleString()} bytes · 1 blob = {BLOB_BYTES_USABLE.toLocaleString()}{' '}
          usable bytes
        </p>
      </section>

      {priced && (
        <section className="grid md:grid-cols-2 gap-4">
          <CostCard
            title="Calldata"
            gasLabel="Calldata gas"
            gas={priced.calldata.gas}
            wei={priced.calldata.weiCost}
            ethUsd={priced.ethUsd}
            extra={[
              { k: 'Zero bytes', v: priced.calldata.zeroBytes.toLocaleString() },
              { k: 'Nonzero bytes', v: priced.calldata.nonzeroBytes.toLocaleString() },
              { k: 'Standard gas', v: priced.calldata.standardGas.toLocaleString() },
              { k: 'EIP-7623 floor', v: priced.calldata.floorGas.toLocaleString() },
            ]}
          />
          <CostCard
            title="Blobs"
            gasLabel="Blob gas"
            gas={priced.blob.blobGas}
            wei={priced.blob.totalWei}
            ethUsd={priced.ethUsd}
            extra={[
              { k: 'Blobs used', v: priced.blob.blobs.toString() },
              { k: 'Blob fee', v: `${weiToEth(priced.blob.blobFeeWei)} ETH` },
              {
                k: 'Tx envelope',
                v: `${priced.blob.envelopeGas.toLocaleString()} gas · ${weiToEth(priced.blob.envelopeFeeWei)} ETH`,
              },
            ]}
          />
          <RatioBanner
            calldataWei={priced.calldata.weiCost}
            blobWei={priced.blob.totalWei}
            ethUsd={priced.ethUsd}
            empty={bytes.length === 0}
          />
        </section>
      )}

      <footer className="text-xs text-slate-500 pt-6">
        Prices reflect base fees only. Real transactions also pay a priority tip. Blob math uses
        4096 × 31 = 126,976 usable bytes per blob (EIP-4844 BLS field encoding) and 131,072 blob
        gas per blob. Calldata uses 16 gas/nonzero byte, 4 gas/zero byte, with the post-Pectra
        EIP-7623 floor of 10 × tokens.
      </footer>
    </main>
  );
}

function tabCls(active: boolean) {
  return `cursor-pointer px-2 py-1 ${active ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'}`;
}

function CostCard({
  title,
  gasLabel,
  gas,
  wei,
  ethUsd,
  extra,
}: {
  title: string;
  gasLabel: string;
  gas: bigint;
  wei: bigint;
  ethUsd: number | null;
  extra: { k: string; v: string }[];
}) {
  const usd = weiToUsd(wei, ethUsd);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
      <h3 className="text-sm font-medium text-slate-700">{title}</h3>
      <div className="space-y-1">
        <div className="text-2xl font-mono">{usd ?? `${weiToEth(wei)} ETH`}</div>
        <div className="text-xs text-slate-500 font-mono">
          {usd ? `${weiToEth(wei)} ETH · ` : ''}
          {gasLabel}: {gas.toLocaleString()}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono pt-1 border-t border-slate-100">
        {extra.map((row) => (
          <FragmentRow key={row.k} k={row.k} v={row.v} />
        ))}
      </dl>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right">{v}</dd>
    </>
  );
}

function RatioBanner({
  calldataWei,
  blobWei,
  ethUsd,
  empty,
}: {
  calldataWei: bigint;
  blobWei: bigint;
  ethUsd: number | null;
  empty: boolean;
}) {
  if (empty) return null;
  if (blobWei === 0n) {
    return <div className="md:col-span-2 text-sm text-slate-500">Blob cost is zero.</div>;
  }
  const ratioNum = Number((calldataWei * 10_000n) / blobWei) / 10_000;
  const cheaper = calldataWei > blobWei ? 'Blobs cheaper' : 'Calldata cheaper';
  const savingsWei = calldataWei > blobWei ? calldataWei - blobWei : blobWei - calldataWei;
  const savingsUsd = weiToUsd(savingsWei, ethUsd);
  return (
    <div className="md:col-span-2 rounded-lg border border-slate-200 bg-slate-900 text-white p-3 text-sm font-mono flex items-center justify-between">
      <span>
        {cheaper}
        {savingsUsd ? ` · saves ${savingsUsd}` : ''}
      </span>
      <span>calldata / blob = {ratioNum.toFixed(2)}×</span>
    </div>
  );
}
