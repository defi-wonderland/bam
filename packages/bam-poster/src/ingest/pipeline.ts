import {
  computeMessageId,
  type Address,
  type Bytes32,
  type Message,
} from 'bam-sdk';

import type {
  DecodedMessage,
  MessageValidator,
  PosterStore,
  SubmitHint,
  SubmitResult,
} from '../types.js';
import { checkMonotonicity } from './monotonicity.js';
import { parseEnvelope } from './envelope.js';
import { RateLimiter } from './rate-limit.js';
import { checkSignedTag } from './signed-tag.js';
import { checkSizeBound } from './size-bound.js';

export interface IngestPipelineOptions {
  store: PosterStore;
  validator: MessageValidator;
  rateLimiter: RateLimiter;
  allowlistedTags: readonly Bytes32[];
  maxMessageSizeBytes: number;
  now: () => Date;
}

/**
 * Recovery failures (malformed signatures, oversized nonces, etc.) all
 * land in this sentinel bucket so rotating `author` across bad inputs
 * can't multiply the attacker's effective budget — every un-recoverable
 * envelope competes for the same slots.
 */
const RECOVER_FAILED_KEY = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Enforces the exact ingest order (plan §C-1):
 *
 *     size → signed-tag → recover → rate-limit → monotonicity → validator → insert
 *
 * The full sequence runs under a single `PosterStore.withTxn` so
 * concurrent ingests of the same `(author, nonce)` race cleanly:
 * exactly one wins (plan §C-3). Rate-limit state is separate — it
 * doesn't need to roll back on a later-stage reject.
 *
 * The rate-limit key is the **recovered** signer (via
 * `validator.recoverSigner`), not the claimed `author` from the
 * envelope: otherwise a spammer can cycle the `author` field to land
 * in fresh buckets and force the validator to run on every request
 * (cubic review). `verifyECDSA` only runs after monotonicity, same as
 * before — the recover step is cheap enough that doing it up-front
 * closes the amplification without giving up the CPU-grief ordering.
 */
export class IngestPipeline {
  constructor(private readonly opts: IngestPipelineOptions) {}

  async ingest(raw: Uint8Array, hint?: SubmitHint): Promise<SubmitResult> {
    // 1. Size bound — cheapest guard, runs before any allocation.
    const size = checkSizeBound(raw, this.opts.maxMessageSizeBytes);
    if (!size.ok) return { accepted: false, reason: size.reason };

    // Parse the envelope. `malformed` covers framing problems; this is
    // a decode step, not a validator step.
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return { accepted: false, reason: parsed.result.reason };
    const { contentTag, message } = parsed.envelope;

    // 2. Signed-tag authority vs hint + allowlist. Structural, cheap,
    //    and independent of crypto — do it before the recover step so
    //    hint/tag misuse never forces an ecrecover.
    const tag = checkSignedTag(contentTag, hint?.contentTag, this.opts.allowlistedTags);
    if (!tag.ok) return { accepted: false, reason: tag.reason };

    // Build the canonical DecodedMessage; compute the message id now so
    // the monotonicity check has a stable id under concurrent ingest.
    const sdkMessage: Message = {
      author: message.author,
      timestamp: message.timestamp,
      nonce: Number(message.nonce & 0xffffn),
      content: message.content,
    };
    let messageId: Bytes32;
    try {
      messageId = computeMessageId(sdkMessage);
    } catch {
      return { accepted: false, reason: 'malformed' };
    }

    const decoded: DecodedMessage = {
      author: message.author,
      timestamp: message.timestamp,
      nonce: message.nonce,
      content: message.content,
      contentTag,
      signature: message.signature,
      messageId,
      raw,
    };

    // 3. Rate-limit, keyed on the recovered signer when the validator
    //    exposes that capability. Fallback to claimed author preserves
    //    behavior for custom validators that don't implement signer
    //    recovery, and the garbage-signature path routes to the
    //    sentinel bucket so it can't be amplified by rotating author.
    //    Slots are NOT released on reject — the spam floor is what
    //    stops CPU-grief, and a caller that keeps resubmitting
    //    something we reject IS spamming.
    const rateLimitKey = this.rateLimitKey(decoded);
    const rl = this.opts.rateLimiter.check(rateLimitKey);
    if (!rl.ok) return { accepted: false, reason: rl.reason };

    // 4-6. Monotonicity, validator, insert — all inside one txn so
    // two concurrent ingests on `(author, nonce, content)` resolve to
    // exactly one acceptance.
    return this.opts.store.withTxn(async (txn) => {
      const mono = await checkMonotonicity(decoded.author, decoded.nonce, messageId, txn);
      if (mono.decision === 'reject') {
        return { accepted: false, reason: mono.reason };
      }
      if (mono.decision === 'no_op') {
        // Byte-equal retry — acknowledge with the existing id.
        return { accepted: true, messageId: mono.existingMessageId };
      }

      // 5. Validator runs last — after every cheap gate.
      const val = this.opts.validator.validate(decoded);
      if (!val.ok) {
        return { accepted: false, reason: val.reason };
      }

      // 6. Atomic: record nonce tracker + insert pending row.
      await txn.setNonce({
        author: decoded.author as Address,
        lastNonce: decoded.nonce,
        lastMessageId: messageId,
      });
      const seq = await txn.nextIngestSeq(contentTag);
      await txn.insertPending({
        messageId,
        contentTag,
        author: decoded.author,
        nonce: decoded.nonce,
        timestamp: decoded.timestamp,
        content: new TextEncoder().encode(decoded.content),
        signature: decoded.signature,
        ingestedAt: this.opts.now().getTime(),
        ingestSeq: seq,
      });
      return { accepted: true, messageId };
    });
  }

  private rateLimitKey(decoded: DecodedMessage): Address {
    const recoverSigner = this.opts.validator.recoverSigner;
    if (!recoverSigner) return decoded.author;
    const recovered = recoverSigner.call(this.opts.validator, decoded);
    if (recovered === null) return RECOVER_FAILED_KEY;
    // Unauthenticated envelopes (claimed !== recovered) share the
    // sentinel bucket so rotation across either field can't multiply
    // the attacker's budget. Recovered addresses that match the
    // claimed author key on the authenticated identity.
    if (recovered.toLowerCase() !== decoded.author.toLowerCase()) {
      return RECOVER_FAILED_KEY;
    }
    return recovered;
  }
}
