# Nonce scope and multi-app identity

**Status:** resolved (2026-05) — the "fold `contentTag` into `messageHash`" alternative below was adopted in the tag-binding rework. The current ERC-8180 §*Signing Domain and Message Hash Convention* now defines `messageHash = keccak256(sender ‖ contentTag ‖ nonce ‖ contents)` and the EIP-712 `BAMMessage` struct includes `contentTag`. See [ERC-8180](../specs/erc-8180.md). The historical analysis below is retained because it captures the motivating use case and the trade-offs considered.
**Raised:** 2026-04 (during BAM Poster feature planning)
**Relevant ERC:** [ERC-8180](../specs/erc-8180.md) §*Nonce Semantics*, §*Signing Domain and Message Hash Convention*

> **What this document is:** a record of a design tension surfaced by the reference implementation, pushing it back to the ERC authors per constitution principle III. The BAM Poster ships under the current ERC; this doc captures the question and its implications so the learning isn't lost.

## Observation

ERC-8180 defines the signed message hash as:

```
messageHash = keccak256(abi.encodePacked(sender, nonce, contents))
domain      = keccak256(abi.encodePacked("ERC-BAM.v1", chainId))
signedHash  = keccak256(abi.encodePacked(domain, messageHash))
```

**`contentTag` appears nowhere in the signed payload.** It is carried in the on-chain event (`BlobBatchRegistered`) and in BAM Core calldata, but the signer never commits to it. The ERC's *Nonce Semantics* section is explicit: *"Nonces MUST be per-sender monotonically increasing within the signing protocol."* The signing protocol is `ERC-BAM.v1 × chainId` — not per-tag.

## The tension

Because nonce monotonicity is scoped per-sender globally (per chain) rather than per-sender-per-tag, a single author key used across multiple BAM applications shares **one nonce sequence**.

Concrete scenario: Alice uses one ECDSA key for her BAM identity. She posts on a blog app (tag `blog.v1`) and a forum app (tag `forum.v1`).

- Blog client: Alice's last-accepted nonce is 5 → signs nonce 6.
- Forum client: also sees Alice's last-accepted nonce as 5 (it's the same signing domain) → signs nonce 6.
- Both messages reach the same Poster; the second is rejected as `stale_nonce` — or worse, they reach different Posters and eventually one loses on-chain.

Apps are coupled through Alice's nonce space even though they're otherwise unrelated. To avoid collisions, multi-app clients must either:

1. Use different keys per app — fragments identity across apps, the opposite of the "sovereign identity" story BAM wants to support.
2. Coordinate through a shared observer (Poster, indexer) to learn the current nonce before signing — workable but adds a coordination dependency between apps that in principle don't need one.

Neither is great if the BAM vision is "one identity, many apps".

## A candidate fix: bind `contentTag` into the signing domain

The smallest change that restores per-app independence:

```
domain = keccak256(abi.encodePacked("ERC-BAM.v1", chainId, contentTag))
```

`messageHash` stays `keccak256(sender, nonce, contents)`. Different tags become different signing domains — EIP-712-style. Same `(sender, nonce, contents)` signed under two different tags produces different `signedHash` values. Nonces become per-`(sender, contentTag)` independent.

Alternative: fold `contentTag` into `messageHash` itself (`keccak256(sender, contentTag, nonce, contents)`). Functionally equivalent for isolation; marginally uglier from a "what is the domain" standpoint.

## Implications if adopted

- **Wire-format change** → ERC-8180 version bump (e.g. `"ERC-BAM.v2"` in the domain string).
- **`bam-sdk`** — `signECDSA` / `verifyECDSA` take a `contentTag` parameter; domain-separated hash construction updates accordingly. Dual-runtime — change must land in both Node and browser entrypoints.
- **Existing signed messages** in the demo app's corpus become unverifiable under v2 without re-signing. Migration strategy needed: either support v1 verification alongside v2 for a window, or treat the demo's current data as test fixtures only.
- **Indexers** — the sync path re-derives `signedHash` as part of verification. Updates the same way as the SDK.
- **BAM Poster** — one-line change: the per-sender monotonicity rule narrows to per-`(sender, contentTag)`. No architectural impact.
- **Clients** — each app maintains its own nonce sequence per author. Multi-app identity becomes transparent.

Out of scope for this note: how to handle a message that legitimately belongs to multiple content tags (e.g. cross-posted). The current ERC doesn't support this either; v2 wouldn't have to.

## Resolution (2026-05)

The tag-binding rework adopted the second alternative — folding `contentTag` into `messageHash` itself — across the spec, SDK, Poster, Reader, and demos:

- `messageHash = keccak256(sender ‖ contentTag ‖ nonce ‖ contents)`.
- The EIP-712 `BAMMessage` struct includes `contentTag` as a bound field.
- The Poster's per-sender monotonicity rule is unchanged (still global per sender across served tags); a same-`(sender, nonce)` pair under a different tag now produces a different `messageHash`, so the byte-equal retry path still works without a per-tag scope.
- Indexers and the Reader source `contentTag` from the L1 `BlobBatchRegistered` / `CalldataBatchRegistered` event topic and feed it into `verifyECDSA` / `verifyBLS`. The signature alone is no longer sufficient to attribute a message — the L1 event is the trust anchor for which tag it was bound to.

The Sybil/multi-app coordination story this doc opened with is closed by the binding itself: a key reused across apps still shares one nonce sequence per sender (the ERC's monotonicity rule), but a signature can no longer be re-routed across apps, so the worst-case failure mode is "the second submission lost the nonce race" rather than "the wrong app accepted a foreign message."

## References

- ERC-8180 §*Signing Domain and Message Hash Convention* — `docs/specs/erc-8180.md`
- Cross-tag replay regression — `packages/bam-poster/test/ingest/cross-tag-replay.test.ts`
- Verifier sourcing `contentTag` from the L1 event — `packages/bam-reader/src/verify/dispatch.ts`
