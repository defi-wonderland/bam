# Nonce scope and multi-app identity

**Status:** open design question
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

## Current stance (2026-04)

The BAM Poster ships under the **current** ERC-8180:

- Per-sender nonce monotonicity, scoped per sender globally across all served tags.
- Byte-equal resubmissions of the last-accepted message tolerated as no-ops (retry).
- Any other ingest with `nonce ≤ last_accepted[sender]` rejected as `stale_nonce`.

If the ERC evolves to per-tag signing domains, the Poster's rule narrows to per-`(sender, contentTag)` with a small code change; no re-architecting is needed.

## Action items

- [ ] **Raise with ERC-8180 authors** (Vitalik, Kimmo, Skeletor Spaceman). Share this note as the motivating use case. Venue: `ethereum-magicians.org` ERC-8180 discussion thread or direct review.
- [ ] **Gather signal from demo usage.** If users hit the multi-app coordination cost during the BAM Poster's demo integration, collect the anecdote and fold it into the ERC discussion.
- [ ] **If ERC accepts the change**, open a separate feature to thread it through `bam-sdk`, the sync indexer, and any other callers. The Poster update ships as part of that feature.
- [ ] **If ERC declines**, document the rationale here and update guidance for multi-app BAM clients (recommend per-app keys, or shared-Poster nonce-read helper).

## References

- ERC-8180 §*Nonce Semantics* — `docs/specs/erc-8180.md` (lines 332–343)
- ERC-8180 §*Signing Domain and Message Hash Convention* — `docs/specs/erc-8180.md` (lines 517–545)
