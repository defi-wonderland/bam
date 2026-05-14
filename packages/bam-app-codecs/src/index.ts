/**
 * `bam-app-codecs` — application-level `contents` codecs for BAM apps.
 *
 * Each app's codec is exposed via a subpath export so consumers only
 * pull in what they need:
 *
 *   import { encodePostReplyContents } from 'bam-app-codecs/post-reply';
 *
 * The top-level barrel is intentionally empty. The browser-bundle
 * audit at `tests/browser-audit.test.ts` enforces that every codec
 * subdirectory stays free of Node-only imports — the package is the
 * protocol contract between FE encoders (which run in the browser)
 * and indexer decoders (which run in Node).
 *
 * Protocol-level codecs (ERC-8180 batch, BPE, message header,
 * compression) belong in `bam-sdk`, not here. This package owns the
 * bytes *inside* a message's `contents` field, after `encodeContents`
 * has prepended the 32-byte `contentTag`.
 */

export {};
