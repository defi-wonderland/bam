import type { DegradedPanelResult, NotConfiguredReason } from '../lib/panel-result';

const NOT_CONFIGURED_COPY: Record<NotConfiguredReason, string> = {
  reader_url_not_configured:
    'No Reader URL configured. Open Settings to enter one (or set NEXT_PUBLIC_DEFAULT_READER_URL at build time).',
  poster_url_not_configured:
    'No Poster URL configured. Open Settings to enter one (or set NEXT_PUBLIC_DEFAULT_POSTER_URL at build time).',
  no_content_tags:
    'No content tags configured. Open Settings to add 0x-prefixed bytes32 tags (or set NEXT_PUBLIC_DEFAULT_CONTENT_TAGS at build time).',
};

export function DegradedBody({ result }: { result: DegradedPanelResult }) {
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
