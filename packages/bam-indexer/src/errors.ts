/**
 * Indexer-specific error taxonomy. Mirrors the Reader's pattern
 * (`packages/bam-reader/src/errors.ts`): one base class plus narrow
 * subclasses with stable `reason` fields the CLI maps to exit codes.
 */

export type IndexerErrorReason =
  | 'env_config'
  | 'chain_id_mismatch'
  | 'handler_not_registered'
  | 'unknown_handler'
  | 'reset_missing_yes'
  | 'unsafe_cursor';

export class IndexerError extends Error {
  readonly reason: IndexerErrorReason;
  constructor(reason: IndexerErrorReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'IndexerError';
  }
}

export class EnvConfigError extends IndexerError {
  constructor(message: string) {
    super('env_config', message);
    this.name = 'EnvConfigError';
  }
}

export class ChainIdMismatch extends IndexerError {
  constructor(expected: number, observed: number) {
    super(
      'chain_id_mismatch',
      `INDEXER_CHAIN_ID=${expected} but bam-store reports chainId=${observed}`
    );
    this.name = 'ChainIdMismatch';
  }
}

export class UnknownHandlerError extends IndexerError {
  constructor(name: string, known: string[]) {
    super(
      'unknown_handler',
      `no handler named ${JSON.stringify(name)} is registered. known: ${known.join(', ') || '(none)'}`
    );
    this.name = 'UnknownHandlerError';
  }
}
