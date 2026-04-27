/**
 * Typed errors used by the BAM Reader. These are thrown across internal
 * module boundaries so the loop can classify failures (skip vs halt) and
 * so structured logs include a stable `reason` field per cause.
 */

export type ReaderErrorReason =
  | 'blob_unreachable'
  | 'versioned_hash_mismatch'
  | 'decode_dispatch_failed'
  | 'verify_dispatch_failed'
  | 'chain_id_mismatch';

export const READER_ERROR_REASONS: readonly ReaderErrorReason[] = [
  'blob_unreachable',
  'versioned_hash_mismatch',
  'decode_dispatch_failed',
  'verify_dispatch_failed',
  'chain_id_mismatch',
] as const;

export class ReaderError extends Error {
  readonly reason: ReaderErrorReason;

  constructor(reason: ReaderErrorReason, message: string) {
    super(message);
    this.name = 'ReaderError';
    this.reason = reason;
  }
}

export class BlobUnreachable extends ReaderError {
  constructor(message: string) {
    super('blob_unreachable', message);
    this.name = 'BlobUnreachable';
  }
}

export class VersionedHashMismatch extends ReaderError {
  constructor(message: string) {
    super('versioned_hash_mismatch', message);
    this.name = 'VersionedHashMismatch';
  }
}

export class DecodeDispatchFailed extends ReaderError {
  constructor(message: string) {
    super('decode_dispatch_failed', message);
    this.name = 'DecodeDispatchFailed';
  }
}

export class VerifyDispatchFailed extends ReaderError {
  constructor(message: string) {
    super('verify_dispatch_failed', message);
    this.name = 'VerifyDispatchFailed';
  }
}

export class ChainIdMismatch extends ReaderError {
  constructor(message: string) {
    super('chain_id_mismatch', message);
    this.name = 'ChainIdMismatch';
  }
}
