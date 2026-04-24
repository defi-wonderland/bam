import type { PosterRejection } from '../errors.js';

/**
 * Stable mapping from `PosterRejection` → HTTP status code. The
 * response body always carries `{ reason }` with the enum value; no
 * free-form text ever crosses the library boundary.
 */
export function rejectionToStatus(reason: PosterRejection): number {
  switch (reason) {
    case 'unknown_tag':
    case 'content_tag_mismatch':
    case 'malformed':
    case 'bad_signature':
    case 'stale_nonce':
    case 'duplicate':
      return 400;
    case 'message_too_large':
      return 413;
    case 'rate_limited':
      return 429;
    case 'unhealthy':
      return 503;
    case 'internal_error':
      return 500;
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return 500;
    }
  }
}
