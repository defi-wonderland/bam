/**
 * BAM Protocol Errors
 * @module bam-sdk/errors
 */

import { ErrorCode } from './types.js';

/**
 * Base class for all BAM protocol errors
 */
export class BAMError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BAMError';
  }
}

/**
 * Invalid magic number error
 */
export class InvalidMagicError extends BAMError {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.INVALID_MAGIC,
      `Expected magic 0x${expected.toString(16)}, got 0x${actual.toString(16)}`,
      { expected, actual }
    );
    this.name = 'InvalidMagicError';
  }
}

/**
 * Unsupported protocol version error
 */
export class UnsupportedVersionError extends BAMError {
  constructor(version: number) {
    super(ErrorCode.UNSUPPORTED_VERSION, `Protocol version ${version} not supported`, { version });
    this.name = 'UnsupportedVersionError';
  }
}

/**
 * Invalid flags error
 */
export class InvalidFlagsError extends BAMError {
  constructor(flags: number, reason: string) {
    super(ErrorCode.INVALID_FLAGS, `Invalid flags 0x${flags.toString(16)}: ${reason}`, {
      flags,
      reason,
    });
    this.name = 'InvalidFlagsError';
  }
}

/**
 * Author index out of bounds error
 */
export class AuthorIndexError extends BAMError {
  constructor(index: number, tableSize: number) {
    super(ErrorCode.AUTHOR_INDEX_OOB, `Author index ${index} exceeds table size ${tableSize}`, {
      index,
      tableSize,
    });
    this.name = 'AuthorIndexError';
  }
}

/**
 * Timestamp overflow error
 */
export class TimestampOverflowError extends BAMError {
  constructor(delta: number, maxDelta: number) {
    super(ErrorCode.TIMESTAMP_OVERFLOW, `Timestamp delta ${delta} exceeds maximum ${maxDelta}`, {
      delta,
      maxDelta,
    });
    this.name = 'TimestampOverflowError';
  }
}

/**
 * Content too long error
 */
export class ContentTooLongError extends BAMError {
  constructor(length: number, maxLength: number, unit: 'bytes' | 'characters') {
    super(
      ErrorCode.CONTENT_TOO_LONG,
      `Content length ${length} ${unit} exceeds maximum ${maxLength}`,
      { length, maxLength, unit }
    );
    this.name = 'ContentTooLongError';
  }
}

/**
 * Invalid UTF-8 error
 */
export class InvalidUtf8Error extends BAMError {
  constructor(position?: number) {
    super(
      ErrorCode.INVALID_UTF8,
      position !== undefined
        ? `Invalid UTF-8 at position ${position}`
        : 'Content is not valid UTF-8',
      { position }
    );
    this.name = 'InvalidUtf8Error';
  }
}

/**
 * Decompression failed error
 */
export class DecompressionError extends BAMError {
  constructor(reason: string) {
    super(ErrorCode.DECOMPRESSION_FAILED, `Zstd decompression error: ${reason}`, {
      reason,
    });
    this.name = 'DecompressionError';
  }
}

/**
 * Signature invalid error
 */
export class SignatureError extends BAMError {
  constructor(reason: string) {
    super(ErrorCode.SIGNATURE_INVALID, `Signature verification failed: ${reason}`, {
      reason,
    });
    this.name = 'SignatureError';
  }
}

/**
 * Batch truncated error
 */
export class BatchTruncatedError extends BAMError {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.BATCH_TRUNCATED,
      `Batch declares ${expected} messages but only ${actual} found`,
      { expected, actual }
    );
    this.name = 'BatchTruncatedError';
  }
}

/**
 * Batch overflow error
 */
export class BatchOverflowError extends BAMError {
  constructor(size: number, limit: number) {
    super(ErrorCode.BATCH_OVERFLOW, `Batch size ${size} exceeds ${limit} byte blob limit`, {
      size,
      limit,
      overflow: size - limit,
    });
    this.name = 'BatchOverflowError';
  }
}

/**
 * Unknown signature scheme error (SigType 11 extended mode)
 */
export class UnknownSignatureSchemeError extends BAMError {
  constructor(schemeId: number) {
    super(
      ErrorCode.UNKNOWN_SIGNATURE_SCHEME,
      `Unknown signature scheme 0x${schemeId.toString(16).padStart(2, '0')}`,
      { schemeId }
    );
    this.name = 'UnknownSignatureSchemeError';
  }
}

/**
 * Unsupported scheme version error (SigType 11 extended mode)
 */
export class UnsupportedSchemeVersionError extends BAMError {
  constructor(schemeId: number, version: number) {
    super(
      ErrorCode.UNSUPPORTED_SCHEME_VERSION,
      `Scheme 0x${schemeId.toString(16).padStart(2, '0')} version ${version} not supported`,
      { schemeId, version }
    );
    this.name = 'UnsupportedSchemeVersionError';
  }
}

/**
 * Too many unique authors in batch
 */
export class TooManyAuthorsError extends BAMError {
  constructor(count: number, maxAuthors: number) {
    super(ErrorCode.TOO_MANY_AUTHORS, `Too many unique authors: ${count} (max ${maxAuthors})`, {
      count,
      maxAuthors,
    });
    this.name = 'TooManyAuthorsError';
  }
}

/**
 * Author not found in author table
 */
export class AuthorNotFoundError extends BAMError {
  constructor(author: string) {
    super(ErrorCode.AUTHOR_NOT_FOUND, `Author ${author} not found in author table`, {
      author,
    });
    this.name = 'AuthorNotFoundError';
  }
}

/**
 * `contents` was shorter than the 32-byte `contentTag` prefix BAM requires
 * on every `BAMMessage`.
 */
export class ContentsTooShortError extends BAMError {
  constructor(actualBytes: number) {
    super(
      ErrorCode.CONTENTS_TOO_SHORT,
      `contents must be at least 32 bytes (contentTag prefix); got ${actualBytes}`,
      { actualBytes }
    );
    this.name = 'ContentsTooShortError';
  }
}
