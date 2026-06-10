'use client';

import { useEffect } from 'react';
import { useProof } from '@/lib/queries';
import { relativeFromIso } from '@/lib/time';

interface ProofDrawerProps {
  messageHash: string | null;
  onClose: () => void;
}

export function ProofDrawer({ messageHash, onClose }: ProofDrawerProps) {
  const { data, isLoading, error } = useProof(messageHash);

  useEffect(() => {
    if (messageHash === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [messageHash, onClose]);

  if (messageHash === null) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-slate-900/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Proof bundle"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl"
      >
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">Groth16 proof</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-slate-700"
          >
            Close
          </button>
        </header>

        {isLoading && (
          <div className="space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
          </div>
        )}

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            Couldn&apos;t load proof — {error instanceof Error ? error.message : 'unknown error'}.
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <Field label="messageHash">
              <Mono>{data.messageHash}</Mono>
            </Field>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <Field label="Proof type">{data.proofType}</Field>
              <Field label="SP1 version">{data.sp1Version}</Field>
              <Field label="Cycles">{data.cycles.toLocaleString()}</Field>
              <Field label="Proof size">{data.proofSize} bytes</Field>
              <Field label="Block · tx · msg">
                {data.blockNumber} · {data.txIndex} · {data.msgIndex}
              </Field>
              <Field label="Segment fe">
                {data.startFe}..{data.endFe}
              </Field>
              <Field label="Sender">
                <Mono className="break-all">{data.sender}</Mono>
              </Field>
              <Field label="Nonce">{data.nonce}</Field>
            </div>
            <Field label="Versioned hash">
              <a
                href={`https://sepolia.blobscan.com/blob/${data.versionedHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-xs text-blue-700 hover:underline"
              >
                {data.versionedHash}
              </a>
            </Field>
            {data.txHash && (
              <Field label="Settlement tx">
                <a
                  href={`https://sepolia.etherscan.io/tx/${data.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-xs text-blue-700 hover:underline"
                >
                  {data.txHash}
                </a>
              </Field>
            )}
            <Field label="Proven">{relativeFromIso(data.provenAt)}</Field>

            <div className="flex gap-2 pt-2">
              <a
                href={`/api/proof/${encodeURIComponent(data.messageHash)}/download`}
                download={`${data.messageHash}.proof.json`}
                className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                ⤓ Download proof
              </a>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                }}
                className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Copy bundle JSON
              </button>
            </div>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer text-slate-600">Raw bundle</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 text-[10px]">
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </aside>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm text-slate-800">{children}</div>
    </div>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={`break-all font-mono text-xs text-slate-700 ${className ?? ''}`}>
      {children}
    </code>
  );
}
