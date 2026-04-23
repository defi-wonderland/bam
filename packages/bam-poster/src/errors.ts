/**
 * Stable rejection codes returned by the Poster's ingest path and the
 * HTTP transport. This is the complete, closed set of reasons — no
 * free-form strings cross the library boundary.
 *
 * The HTTP transport maps these to stable status codes; callers should
 * switch over them exhaustively.
 */
export type PosterRejection =
  | 'unknown_tag'
  | 'content_tag_mismatch'
  | 'message_too_large'
  | 'malformed'
  | 'bad_signature'
  | 'stale_nonce'
  | 'duplicate'
  | 'rate_limited'
  | 'unhealthy'
  | 'internal_error';

/**
 * The complete closed set of `PosterRejection` values. Runtime assertions
 * and tests should use this list rather than hard-coding string literals.
 */
export const POSTER_REJECTIONS: readonly PosterRejection[] = [
  'unknown_tag',
  'content_tag_mismatch',
  'message_too_large',
  'malformed',
  'bad_signature',
  'stale_nonce',
  'duplicate',
  'rate_limited',
  'unhealthy',
  'internal_error',
] as const;
