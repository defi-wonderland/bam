/**
 * Per-panel fetch result. Each fetcher in `fetchers.ts` returns one
 * of these and never throws — the page renderer maps `kind` to a
 * status badge so a Reader outage cannot prevent the Poster panels
 * from rendering, and vice versa.
 */

import {
  ReaderConfigError,
  ReaderUnreachableError,
} from './reader-client';
import {
  PosterConfigError,
  PosterUnreachableError,
} from './poster-client';

export type NotConfiguredReason =
  | 'reader_url_not_configured'
  | 'poster_url_not_configured'
  | 'no_content_tags';

export type PanelResult<T> =
  | { kind: 'ok'; data: T; fetchedAt: number }
  | { kind: 'not_configured'; reason: NotConfiguredReason; fetchedAt: number }
  | { kind: 'unreachable'; detail: string; fetchedAt: number }
  | { kind: 'error'; status: number; detail?: string; fetchedAt: number };

export function readerErrorToPanelResult<T>(
  err: unknown,
  fetchedAt: number
): PanelResult<T> | null {
  if (err instanceof ReaderConfigError) {
    return { kind: 'not_configured', reason: 'reader_url_not_configured', fetchedAt };
  }
  if (err instanceof ReaderUnreachableError) {
    return { kind: 'unreachable', detail: err.message, fetchedAt };
  }
  return null;
}

export function posterErrorToPanelResult<T>(
  err: unknown,
  fetchedAt: number
): PanelResult<T> | null {
  if (err instanceof PosterConfigError) {
    return { kind: 'not_configured', reason: 'poster_url_not_configured', fetchedAt };
  }
  if (err instanceof PosterUnreachableError) {
    return { kind: 'unreachable', detail: err.message, fetchedAt };
  }
  return null;
}
