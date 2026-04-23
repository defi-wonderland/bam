import { describe, it, expect } from 'vitest';
import { POSTER_REJECTIONS, type PosterRejection } from '../src/errors.js';

describe('PosterRejection', () => {
  it('lists exactly the ten reasons from plan.md §Public API', () => {
    expect(POSTER_REJECTIONS).toEqual([
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
    ]);
    expect(POSTER_REJECTIONS).toHaveLength(10);
    expect(new Set(POSTER_REJECTIONS).size).toBe(10);
  });

  it('exhausts the PosterRejection union (never-arm check)', () => {
    // A switch over every member of the union, with a `never` default
    // arm. If a new member is added to `PosterRejection` but this
    // switch is not updated, TypeScript will fail the build because
    // `reason` in the default arm will no longer narrow to `never`.
    const labelOf = (reason: PosterRejection): string => {
      switch (reason) {
        case 'unknown_tag':
          return 'unknown_tag';
        case 'content_tag_mismatch':
          return 'content_tag_mismatch';
        case 'message_too_large':
          return 'message_too_large';
        case 'malformed':
          return 'malformed';
        case 'bad_signature':
          return 'bad_signature';
        case 'stale_nonce':
          return 'stale_nonce';
        case 'duplicate':
          return 'duplicate';
        case 'rate_limited':
          return 'rate_limited';
        case 'unhealthy':
          return 'unhealthy';
        case 'internal_error':
          return 'internal_error';
        default: {
          const _exhaustive: never = reason;
          throw new Error(`unreachable: ${_exhaustive as string}`);
        }
      }
    };

    for (const reason of POSTER_REJECTIONS) {
      expect(labelOf(reason)).toBe(reason);
    }
  });
});
