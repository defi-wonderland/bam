import { describe, expect, it } from 'vitest';

import {
  posterErrorToPanelResult,
  readerErrorToPanelResult,
  type PanelResult,
} from '../src/lib/panel-result';
import {
  ReaderConfigError,
  ReaderUnreachableError,
} from '../src/lib/reader-client';
import {
  PosterConfigError,
  PosterUnreachableError,
} from '../src/lib/poster-client';

const FETCHED_AT = 1_700_000_000_000;

describe('readerErrorToPanelResult', () => {
  it('maps ReaderConfigError to not_configured', () => {
    const r = readerErrorToPanelResult<unknown>(
      new ReaderConfigError('READER_URL env is required'),
      FETCHED_AT
    );
    expect(r).toEqual({
      kind: 'not_configured',
      reason: 'reader_url_not_configured',
      fetchedAt: FETCHED_AT,
    });
  });

  it('maps ReaderUnreachableError to unreachable, preserving the message', () => {
    const r = readerErrorToPanelResult<unknown>(
      new ReaderUnreachableError('connection refused'),
      FETCHED_AT
    );
    expect(r).toEqual({
      kind: 'unreachable',
      detail: 'connection refused',
      fetchedAt: FETCHED_AT,
    });
  });

  it('returns null for unrelated errors so caller can rethrow', () => {
    expect(readerErrorToPanelResult<unknown>(new Error('boom'), FETCHED_AT)).toBeNull();
    expect(readerErrorToPanelResult<unknown>('string error', FETCHED_AT)).toBeNull();
    expect(
      readerErrorToPanelResult<unknown>(
        new PosterUnreachableError('wrong service'),
        FETCHED_AT
      )
    ).toBeNull();
  });
});

describe('posterErrorToPanelResult', () => {
  it('maps PosterConfigError to not_configured', () => {
    const r = posterErrorToPanelResult<unknown>(
      new PosterConfigError('POSTER_URL env is required'),
      FETCHED_AT
    );
    expect(r).toEqual({
      kind: 'not_configured',
      reason: 'poster_url_not_configured',
      fetchedAt: FETCHED_AT,
    });
  });

  it('maps PosterUnreachableError to unreachable, preserving the message', () => {
    const r = posterErrorToPanelResult<unknown>(
      new PosterUnreachableError('timeout'),
      FETCHED_AT
    );
    expect(r).toEqual({
      kind: 'unreachable',
      detail: 'timeout',
      fetchedAt: FETCHED_AT,
    });
  });

  it('returns null for unrelated errors', () => {
    expect(posterErrorToPanelResult<unknown>(new Error('boom'), FETCHED_AT)).toBeNull();
    expect(
      posterErrorToPanelResult<unknown>(new ReaderUnreachableError('wrong service'), FETCHED_AT)
    ).toBeNull();
  });
});

describe('PanelResult variants are exhaustive', () => {
  it('compiles for all four kinds', () => {
    const ok: PanelResult<{ x: number }> = { kind: 'ok', data: { x: 1 }, fetchedAt: FETCHED_AT };
    const nc: PanelResult<unknown> = {
      kind: 'not_configured',
      reason: 'no_content_tags',
      fetchedAt: FETCHED_AT,
    };
    const ur: PanelResult<unknown> = {
      kind: 'unreachable',
      detail: 'down',
      fetchedAt: FETCHED_AT,
    };
    const er: PanelResult<unknown> = {
      kind: 'error',
      status: 500,
      detail: 'internal',
      fetchedAt: FETCHED_AT,
    };
    expect([ok.kind, nc.kind, ur.kind, er.kind]).toEqual([
      'ok',
      'not_configured',
      'unreachable',
      'error',
    ]);
  });
});
