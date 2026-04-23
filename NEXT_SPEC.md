# ERC-8180 primitive layer in `bam-sdk` — Requirements (draft for `/specify`)

> Rough requirements for the next feature. Purpose: feed into `/specify` to
> produce a formal feature spec. Follow-up from feature `001-bam-poster`,
> which surfaced the issue below.

## What

Decouple `bam-sdk`'s ERC-8180 protocol primitives from `message-in-a-blobble`'s v1 application wire format. After this feature, the SDK exposes a clean "ERC-triple" surface — `(sender, nonce, contents: bytes)` — that the Poster and any indexer / future BAM application can call without inheriting the v1 social-messaging schema. The v1 Message format either moves into an explicit app module or is deleted; no backwards compatibility is preserved (existing demo data may be discarded).

## Why

Feature `001-bam-poster` surfaced a leaky abstraction:

- **ERC-8180 says:** `messageHash = keccak256(sender || nonce || contents)` where `contents: bytes` is opaque at the protocol level.
- **`bam-sdk`'s `computeMessageHash(msg: Message)` actually hashes:** `magic || version || flags || author || timestamp || nonce || content_len || content` — a v1-social-messaging wire format that embeds timestamp as a first-class signed field and is **not** the ERC messageHash.
- **The Poster inherited the coupling:** its `poster_pending` schema has a `timestamp` column, its `DecodedMessage` has a `content: string` + `timestamp: number`, and its default validator + submission path go through v1-shaped `computeMessageHash`. A future BAM app with a different content schema (forum post, blog entry, governance intent) can't use this Poster without a rewrite.

The right place to fix this is the SDK: apps should put whatever structured fields they want into an opaque `contents` blob, and the protocol layer should only know about `(sender, nonce, contents)`.

## In scope

1. **ERC-primitive functions in `bam-sdk`.** Replace v1-Message-shaped hashers with signatures that take the ERC triple directly:
   ```ts
   computeMessageHash(sender: Address, nonce: bigint, contents: Uint8Array): Bytes32
   computeMessageId(sender: Address, nonce: bigint, contents: Uint8Array): Bytes32
   computeSignedHash(messageHash: Bytes32, chainId: number): Bytes32
   ```
   All three match the ERC formulas exactly.
2. **`BAMMessage` as the canonical public shape.** `{ sender: Address, nonce: bigint, contents: Uint8Array }`. Already exists in `types.ts`; promote it to the primary export. Drop the v1-shaped `Message` type (`{ author, timestamp, nonce, content }`) from the public surface.
3. **Protocol-level batch codec.** `encodeBatch(messages: BAMMessage[], signatures: Uint8Array[]): Uint8Array` and the matching `decodeBatch`. Simpler layout: `(sender || nonce || contents_len || contents || signature)` concatenation with a header, ZSTD-compressed. No per-author tables, no timestamp-delta tricks, no magic bytes — those were v1-social optimizations. Apps that want richer packing provide their own codec via a pluggable interface.
4. **Signer helpers aligned with the ERC.** `signECDSA` takes a `signedHash` and signs it verbatim; no more "hash a structured message, then personal-sign." Callers compose `computeMessageHash` → `computeSignedHash` → `signECDSA` explicitly.
5. **Optional v1-social app module.** If `message-in-a-blobble` (or any other app) still wants the per-author table / timestamp-delta framing, it lives in `packages/bam-sdk/src/apps/v1-social/` as a separate entrypoint and is imported only by apps that opt in. If nobody opts in, delete it.
6. **Poster refactor.**
   - `DecodedMessage` becomes `{ author, nonce, contents: Uint8Array, signature, contentTag, messageId, raw }`. Drop `timestamp`, drop `content: string`.
   - Ingest envelope: `{ contentTag, message: { author, nonce, contents: "0x…", signature } }`.
   - `poster_pending` schema: drop `timestamp` column; rename `content BLOB` → `contents BLOB`.
   - Default validator calls the new ERC-primitive `computeMessageHash(sender, nonce, contents)`.
   - `MessageSnapshot` (retained on `poster_submitted_batches` for reorg re-enqueue) drops `timestamp` + `content`, keeps `contents` bytes.
7. **Demo refactor.**
   - `MessageComposer` serializes its `{ timestamp, content }` into a `contents` blob (codec choice is the demo's — simplest: ABI-encoded `(uint64, string)` or a small TLV). Signs the ERC `signedHash` over `(author, nonce, contents)`.
   - `MessageList` deserializes `contents` back into `{ timestamp, content }` for display.
   - Sync indexer uses the app's deserializer to turn on-chain `contents` into displayable rows.
   - `api/messages` POST body shape changes to the new envelope.

## Out of scope

- Backwards compatibility with existing v1-signed demo data. Old messages can be discarded.
- Live-anvil/forge e2e harness (the `001-bam-poster` suite covers the C-14 invariant in-process; this feature inherits that).
- Changes to the BAM Core contract or ERC-8180 itself — the SDK is the thing that diverged; the ERC stays put.
- A browser-friendly v1-social decoder for the sync indexer's UI (if needed, tracked separately).

## Acceptance criteria

- Every `bam-sdk` primitive that returns a hash or id operates on the ERC triple, not on a v1 Message shape. `computeMessageHash(msg: Message)` no longer exists.
- `BAMMessage` is the exported canonical message type. `Message` (v1 wire format) is either not exported or only exported from `bam-sdk/apps/v1-social`.
- `bam-sdk`'s existing tests for hash/id functions update to call the new triple-shape signatures and pass.
- The Poster's `DecodedMessage`, envelope, DB schema, validator, submission path, and snapshots no longer contain `timestamp` or `content: string`. Only `contents: Uint8Array`.
- `message-in-a-blobble`'s ingest → pending → flush → confirmed e2e test still passes, now via the ERC-primitive path.
- Browser-reachability gate (G-5) still passes.
- Error-hygiene gate (G-7) still passes.

## Adversarial notes / open questions

- **v1-social decoder discoverability.** If the sync indexer needs to decode `contents` for display, it needs a deserializer. Does that live in `bam-sdk` under an app entrypoint, or in the demo? Leaning "in the demo" since it's the demo's schema, but SDK could ship a canonical one.
- **`signECDSA`'s shape.** The current demo uses EIP-191 personal_sign. ERC-8180 prescribes a domain-separated hash (`keccak256("ERC-BAM.v1" || chainId) || messageHash`). Switch to the domain-separated form? That's what the ERC says; doing anything else perpetuates the divergence.
- **Batch format compression.** Ripping out timestamp-delta + author-table compression loses some per-blob density for chat-style apps. Accept the density regression for v1, or preserve v1-social as an opt-in codec? Leaning "accept regression; revisit if any app actually hits blob-capacity limits."
- **Scheme-0x01 registry lookup.** If ERC-8180 eventually requires an on-chain registry lookup for author→pubkey, the default validator gains an on-chain read dependency. Call out the seam for that now.

## Package / file impact

- `packages/bam-sdk/src/message.ts` — rewrite `computeMessageHash` / `computeMessageId`; drop `Message`-shaped variants.
- `packages/bam-sdk/src/batch.ts` — rewrite `encodeBatch` / `decodeBatch` / `estimateBatchSize` to operate on `BAMMessage[]`.
- `packages/bam-sdk/src/signatures.ts` — `signECDSA` / `verifyECDSA` take ERC-shaped inputs.
- `packages/bam-sdk/src/types.ts` — `BAMMessage` promoted; `Message` removed (or moved).
- `packages/bam-sdk/src/apps/v1-social/` **(NEW, maybe)** — optional app module for the social-messaging schema.
- `packages/bam-sdk/src/browser.ts` — re-exports for the ERC primitives.
- `packages/bam-poster/src/types.ts`, `src/ingest/envelope.ts`, `src/ingest/pipeline.ts`, `src/pool/*`, `src/submission/*`, `src/validator/default-ecdsa.ts` — all lose `timestamp` / `content: string`.
- `apps/message-in-a-blobble/src/components/MessageComposer.tsx` — serialize contents before signing.
- `apps/message-in-a-blobble/src/components/MessageList.tsx` — deserialize contents for display.
- `apps/message-in-a-blobble/src/app/api/sync/route.ts` — use the demo's deserializer.
- Version: `bam-sdk` major bump; `@bam/poster` minor (internal refactor, same public API).

## Constitution check (informal)

- **I. Stateless core** — unaffected; no contract changes.
- **II. Dual-runtime SDK** — preserved; both entrypoints get the new primitives.
- **III. Spec-backed, spec-evolving protocol changes** — this feature *is* the alignment. ERC stays put; SDK catches up.
- **IV. Explicit security posture** — signature-scheme and hash-construction change; update §*Security impact* accordingly. Round-trip tests against the demo's new signed corpus lock behavior down.
- **V. CROPS** — no change.
- **VI. L1-preferred** — unaffected.
- **VII. Local-first / VIII. Verification mode** — unaffected.
- **IX. Minimal dependencies** — unaffected.
- **X. Demo-app-driven** — `message-in-a-blobble` exercises the new primitives end-to-end.
