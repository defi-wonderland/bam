import type { NotConfiguredReason, PanelResult } from '../lib/panel-result';

const NOT_CONFIGURED_COPY: Record<NotConfiguredReason, string> = {
  reader_url_not_configured:
    'READER_URL is not set on this Explorer. Set it to the Reader’s base URL.',
  poster_url_not_configured:
    'POSTER_URL is not set on this Explorer. Set it to the Poster’s base URL.',
  no_content_tags:
    'EXPLORER_CONTENT_TAGS is empty. Add one or more 0x-prefixed bytes32 tags to surface Reader-list panels.',
};

export function DegradedBody({
  result,
}: {
  result: Exclude<PanelResult<unknown>, { kind: 'ok' }>;
}) {
  switch (result.kind) {
    case 'not_configured':
      return (
        <p className="text-slate-600" data-testid="panel-not-configured">
          {NOT_CONFIGURED_COPY[result.reason]}
        </p>
      );
    case 'unreachable':
      return (
        <p className="text-amber-700" data-testid="panel-unreachable">
          Upstream did not respond
          {result.detail ? `: ${result.detail}` : ''}.
        </p>
      );
    case 'error':
      return (
        <p className="text-rose-700" data-testid="panel-error">
          Upstream returned status {result.status}
          {result.detail ? ` (${result.detail})` : ''}.
        </p>
      );
  }
}
