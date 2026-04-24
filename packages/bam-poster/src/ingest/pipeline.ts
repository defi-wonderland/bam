import { computeMessageHash, type Address, type Bytes32 } from 'bam-sdk';

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
import { checkContentTag } from './signed-tag.js';
import { checkSizeBound } from './size-bound.js';

export interface IngestPipelineOptions {
  store: PosterStore;
  validator: MessageValidator;
  rateLimiter: RateLimiter;
  allowlistedTags: readonly Bytes32[];
  maxMessageSizeBytes: number;
  maxContentsSizeBytes: number;
  now: () => Date;
}

/**
 * Recovery failures (malformed signatures, oversized nonces, etc.) all
 * land in this sentinel bucket so rotating `sender` across bad inputs
 * can't multiply the attacker's effective budget — every un-recoverable
 * envelope competes for the same slots.
 */
const RECOVER_FAILED_KEY = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Enforces the exact ingest order:
 *
 *     size → content-tag → recover → rate-limit → monotonicity → validator → insert
 *
 * The full sequence runs under a single `PosterStore.withTxn` so
 * concurrent ingests of the same `(sender, nonce)` race cleanly:
 * exactly one wins. Rate-limit state is separate — it doesn't need to
 * roll back on a later-stage reject.
 *
 * `contentTag` authority is enforced up-front: `contents[0..32]` is
 * checked against the envelope-level tag hint and against the operator's
 * allowlist (see `checkContentTag`) before any crypto runs. The pre-batch
 * identifier is the ERC-8180 `messageHash` (a pure function of
 * `(sender, nonce, contents)`), surfaced on the accepted response and
 * used as the monotonicity dedup token.
 */
export class IngestPipeline {
  constructor(private readonly opts: IngestPipelineOptions) {}

  async ingest(raw: Uint8Array, hint?: SubmitHint): Promise<SubmitResult> {
    // 1. Size bound — cheapest guard, runs before any allocation.
    const size = checkSizeBound(raw, this.opts.maxMessageSizeBytes);
    if (!size.ok) return { accepted: false, reason: size.reason };

    // Parse the envelope. `malformed` covers framing + shape problems.
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return { accepted: false, reason: parsed.result.reason };
    const { contentTag, message } = parsed.envelope;

    // Enforce the `contents` byte cap alongside the envelope wire cap.
    if (message.contents.length > this.opts.maxContentsSizeBytes) {
      return { accepted: false, reason: 'message_too_large' };
    }

    // Optional transport-level hint (e.g. an HTTP header). Must match
    // the envelope's `contentTag` — which is itself checked against
    // the signed prefix below.
    if (hint?.contentTag !== undefined && hint.contentTag.toLowerCase() !== contentTag.toLowerCase()) {
      return { accepted: false, reason: 'content_tag_mismatch' };
    }

    // 2. Content-tag authority: contentTag must equal contents[0..32]
    //    AND must be on the operator's allowlist. Runs before any
    //    crypto so a rogue hint never forces an ecrecover.
    const tag = checkContentTag(contentTag, message.contents, this.opts.allowlistedTags);
    if (!tag.ok) return { accepted: false, reason: tag.reason };

    // Compute the ERC-8180 messageHash. Determined purely by
    // (sender, nonce, contents); stable pre-batch identifier.
    let messageHash: Bytes32;
    try {
      messageHash = computeMessageHash(message.sender, message.nonce, message.contents);
    } catch {
      return { accepted: false, reason: 'malformed' };
    }

    const decoded: DecodedMessage = {
      sender: message.sender,
      nonce: message.nonce,
      contents: message.contents,
      contentTag,
      signature: message.signature,
      messageHash,
    };

    // 3. Rate-limit, keyed on the recovered signer when the validator
    //    exposes that capability. Fallback to the claimed sender
    //    preserves behavior for custom validators that don't
    //    implement signer recovery; the garbage-signature path routes
    //    to the sentinel bucket so it can't be amplified by rotation.
    const rateLimitKey = this.rateLimitKey(decoded);
    const rl = this.opts.rateLimiter.check(rateLimitKey);
    if (!rl.ok) return { accepted: false, reason: rl.reason };

    // 4-6. Monotonicity, validator, insert — all inside one txn so
    // two concurrent ingests on `(sender, nonce)` resolve to exactly
    // one acceptance.
    return this.opts.store.withTxn(async (txn) => {
      const mono = await checkMonotonicity(decoded.sender, decoded.nonce, messageHash, txn);
      if (mono.decision === 'reject') {
        return { accepted: false, reason: mono.reason };
      }
      if (mono.decision === 'no_op') {
        // Byte-equal retry — acknowledge with the existing messageHash.
        return { accepted: true, messageHash: mono.existingMessageHash };
      }

      // 5. Validator runs last — after every cheap gate.
      const val = this.opts.validator.validate(decoded);
      if (!val.ok) {
        return { accepted: false, reason: val.reason };
      }

      // 6. Atomic: record nonce tracker + insert pending row.
      await txn.setNonce({
        sender: decoded.sender,
        lastNonce: decoded.nonce,
        lastMessageHash: messageHash,
      });
      const seq = await txn.nextIngestSeq(contentTag);
      await txn.insertPending({
        contentTag,
        sender: decoded.sender,
        nonce: decoded.nonce,
        contents: decoded.contents,
        signature: decoded.signature,
        messageHash,
        ingestedAt: this.opts.now().getTime(),
        ingestSeq: seq,
      });
      return { accepted: true, messageHash };
    });
  }

  private rateLimitKey(decoded: DecodedMessage): Address {
    const recoverSigner = this.opts.validator.recoverSigner;
    if (!recoverSigner) return decoded.sender;
    let recovered: Address | null;
    try {
      recovered = recoverSigner.call(this.opts.validator, decoded);
    } catch {
      return RECOVER_FAILED_KEY;
    }
    if (recovered === null) return RECOVER_FAILED_KEY;
    if (recovered.toLowerCase() !== decoded.sender.toLowerCase()) {
      return RECOVER_FAILED_KEY;
    }
    return recovered;
  }
}
