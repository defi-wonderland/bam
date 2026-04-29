'use client';

import { useState, type ReactNode } from 'react';

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 p-5 mb-4"
    >
      <header className="mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{description}</p>
        ) : null}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        'w-full px-2 py-1.5 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
        (props.className ?? '')
      }
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={
        'w-full px-2 py-1.5 text-sm bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
        (props.className ?? '')
      }
    />
  );
}

export function Button({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={
        'px-3 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ' +
        (props.className ?? '')
      }
    >
      {children}
    </button>
  );
}

export function Output({ value, label = 'Output' }: { value: string; label?: string }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-1">
        {label}
      </div>
      <pre className="text-xs px-2 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto">
        {value}
      </pre>
    </div>
  );
}

export function ErrorBox({ value }: { value: string }) {
  if (!value) return null;
  return (
    <div className="text-xs px-2 py-1.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap break-all">
      {value}
    </div>
  );
}

/**
 * Hook that wraps a (possibly async) action: tracks its output, error,
 * and pending state so each Section can call it without repeating
 * try/catch boilerplate.
 */
export function useAction<T>() {
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function run(fn: () => Promise<T> | T, format: (value: T) => string = String) {
    setError('');
    setPending(true);
    try {
      const result = await fn();
      setOutput(format(result));
    } catch (err) {
      setOutput('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return { output, error, pending, run, setOutput, setError };
}
