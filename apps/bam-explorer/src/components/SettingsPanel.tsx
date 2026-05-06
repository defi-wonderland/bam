'use client';

import { useState } from 'react';

import type { OverrideKey, UseExplorerConfig } from '../lib/client-config';

/**
 * In-page Settings drawer. The viewer types Reader/Poster URLs, an
 * optional Poster bearer token, and a comma-separated content-tags
 * list; values save through `useExplorerConfig` and persist in
 * `localStorage`. Clearing a field reverts to the build-time env
 * default.
 *
 * Props are an `Explorer` config bundle so this component is easy
 * to test in isolation: pass a fake `useExplorerConfig` value.
 */
export function SettingsPanel({
  cfg,
  onApply,
}: {
  cfg: UseExplorerConfig;
  onApply?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!cfg.mounted) {
    return (
      <button
        type="button"
        disabled
        className="text-sm text-slate-500 px-3 py-1 rounded ring-1 ring-slate-200 bg-white"
      >
        Settings
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-slate-700 hover:text-slate-900 px-3 py-1 rounded ring-1 ring-slate-200 bg-white"
        data-testid="settings-toggle"
      >
        Settings{open ? ' ▲' : ' ▼'}
      </button>
      {open && (
        <div
          data-testid="settings-panel"
          className="absolute right-6 top-20 z-10 w-[28rem] max-w-[90vw] bg-white rounded-lg ring-1 ring-slate-200 shadow-lg p-4"
        >
          <SettingsForm cfg={cfg} onApply={() => { setOpen(false); onApply?.(); }} />
        </div>
      )}
    </>
  );
}

function SettingsForm({ cfg, onApply }: { cfg: UseExplorerConfig; onApply: () => void }) {
  const [readerUrl, setReaderUrl] = useState(cfg.rawOverrides.readerUrl ?? '');
  const [posterUrl, setPosterUrl] = useState(cfg.rawOverrides.posterUrl ?? '');
  const [posterAuthToken, setPosterAuthToken] = useState(cfg.rawOverrides.posterAuthToken ?? '');
  const [contentTagsRaw, setContentTagsRaw] = useState(cfg.rawOverrides.contentTagsRaw ?? '');

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const writeOrClear = (key: OverrideKey, value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) cfg.clearOverride(key);
      else cfg.setOverride(key, trimmed);
    };
    writeOrClear('readerUrl', readerUrl);
    writeOrClear('posterUrl', posterUrl);
    writeOrClear('posterAuthToken', posterAuthToken);
    writeOrClear('contentTagsRaw', contentTagsRaw);
    onApply();
  };

  const reset = () => {
    cfg.resetAll();
    setReaderUrl('');
    setPosterUrl('');
    setPosterAuthToken('');
    setContentTagsRaw('');
    onApply();
  };

  return (
    <form onSubmit={apply} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Explorer settings</h2>
      <p className="text-xs text-slate-500">
        Stored in your browser&apos;s <code>localStorage</code>. Empty fields
        fall back to build-time defaults.
      </p>

      <Field
        label="Reader URL"
        defaultValue={cfg.config.readerUrl}
        overridden={cfg.flags.readerUrl}
      >
        <input
          type="url"
          value={readerUrl}
          onChange={(e) => setReaderUrl(e.target.value)}
          placeholder={cfg.config.readerUrl || 'http://localhost:8788'}
          data-testid="settings-reader-url"
          className="w-full text-sm font-mono px-2 py-1 rounded ring-1 ring-slate-200 focus:ring-slate-500"
        />
      </Field>

      <Field
        label="Poster URL"
        defaultValue={cfg.config.posterUrl}
        overridden={cfg.flags.posterUrl}
      >
        <input
          type="url"
          value={posterUrl}
          onChange={(e) => setPosterUrl(e.target.value)}
          placeholder={cfg.config.posterUrl || 'http://localhost:8787'}
          data-testid="settings-poster-url"
          className="w-full text-sm font-mono px-2 py-1 rounded ring-1 ring-slate-200 focus:ring-slate-500"
        />
      </Field>

      <Field
        label="Poster bearer token (optional)"
        defaultValue=""
        overridden={cfg.flags.posterAuthToken}
        helper="No build-time default — only saved here is sent."
      >
        <input
          type="password"
          value={posterAuthToken}
          onChange={(e) => setPosterAuthToken(e.target.value)}
          placeholder="(none)"
          data-testid="settings-poster-token"
          autoComplete="off"
          className="w-full text-sm font-mono px-2 py-1 rounded ring-1 ring-slate-200 focus:ring-slate-500"
        />
      </Field>

      <Field
        label="Content tags (comma-separated)"
        defaultValue={cfg.config.contentTags.join(', ')}
        overridden={cfg.flags.contentTags}
      >
        <textarea
          value={contentTagsRaw}
          onChange={(e) => setContentTagsRaw(e.target.value)}
          placeholder="0x…aa, 0x…bb"
          rows={2}
          data-testid="settings-content-tags"
          className="w-full text-xs font-mono px-2 py-1 rounded ring-1 ring-slate-200 focus:ring-slate-500"
        />
      </Field>

      <div className="flex justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={reset}
          data-testid="settings-reset"
          className="text-xs text-slate-600 hover:text-slate-900 underline"
        >
          Reset to defaults
        </button>
        <button
          type="submit"
          data-testid="settings-apply"
          className="text-sm font-medium px-3 py-1 rounded bg-slate-900 text-white hover:bg-slate-700"
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  defaultValue,
  overridden,
  helper,
  children,
}: {
  label: string;
  defaultValue: string;
  overridden: boolean;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-700 flex items-center gap-2">
        {label}
        {overridden && (
          <span
            data-testid="settings-override-flag"
            className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
          >
            override
          </span>
        )}
      </span>
      {children}
      <span className="text-[11px] text-slate-500 font-mono truncate">
        default: {defaultValue || '(none)'}
        {helper ? ` — ${helper}` : ''}
      </span>
    </label>
  );
}
