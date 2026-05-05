import type { Bytes32 } from 'bam-sdk';

import type { PanelResult } from '../src/lib/panel-result';

export const FETCHED_AT = 1_700_000_000_000;
export const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
export const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
export const TX_HASH = '0x' + 'cc'.repeat(32);

export function ok<T>(data: T): PanelResult<T> {
  return { kind: 'ok', data, fetchedAt: FETCHED_AT };
}

export function unreachable<T>(detail = 'down'): PanelResult<T> {
  return { kind: 'unreachable', detail, fetchedAt: FETCHED_AT };
}

export function panelVariants(okData: unknown): Array<{
  label: PanelResult<unknown>['kind'];
  result: PanelResult<unknown>;
}> {
  return [
    { label: 'ok', result: ok(okData) },
    {
      label: 'not_configured',
      result: {
        kind: 'not_configured',
        reason: 'poster_url_not_configured',
        fetchedAt: FETCHED_AT,
      },
    },
    { label: 'unreachable', result: unreachable('connection refused') },
    { label: 'error', result: { kind: 'error', status: 503, fetchedAt: FETCHED_AT } },
  ];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
