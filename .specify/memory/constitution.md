# BAM Constitution

*Version 0.1.0 — draft, unratified*

Non-negotiable principles that govern technical decisions in the BAM
reference implementation. Consulted by Claude at the start of every `/plan`.
Amended via PR with explicit rationale and a version bump.

This document is a **skeleton**. Principles are placeholders for iteration —
redline, argue with, split, or drop them.

## Principles

### I. Stateless core

Core protocol contracts (`BlobAuthenticatedMessagingCore`, and any future
contract whose role is to serve as the canonical on-chain anchor of the BAM
protocol) emit events only and do not read storage on the hot path.
Ancillary contracts — registries, exposers, verifiers — may hold state when
state is intrinsic to their role.

**Why:** The protocol's verifiability depends on being fully reconstructible
from calldata and events. State on the core creates trust-requiring read
dependencies.

**In plans:** New storage or state reads on a core contract require explicit
rationale. Adding a new ancillary contract does not.

### II. Dual-runtime SDK

`bam-sdk` supports Node.js and browser environments as first-class targets.
The browser entrypoint's public API is a subset of, and semantically
consistent with, the Node entrypoint.

**Why:** The SDK is used both by operator tooling (Node) and end-user dApps
(browser). Runtime divergence degrades the reference implementation's
usefulness.

**In plans:** SDK features state which runtime(s) they target and how the
other is affected (parity, graceful degradation, or scoped exclusion with
justification).

### III. Spec-backed protocol changes

Changes to wire formats, contract interfaces, or semantics defined in
`docs/specs/erc-8179.md` or `docs/specs/erc-8180.md` are accompanied by
updates to those specs in the same change.

**Why:** This repo is a *reference* implementation. Drift between code and
published spec makes it worse than useless — it misleads.

**In plans:** Protocol-touching features list the spec sections they modify
and include the spec edit in the task list.

### IV. Explicit security posture on crypto paths

The project is experimental and unaudited. Changes to signature verification,
key handling, KZG proof generation, compression codecs, or any path on which
message authenticity or confidentiality depends are flagged as
security-sensitive.

**Why:** Unaudited code can't rely on "everything is reviewed carefully."
Explicit flagging ensures crypto-adjacent changes get targeted review, not
routine skimming.

**In plans:** Security-sensitive changes include a *Security impact* section
stating what invariant is affected, what could break, and what tests exercise
it.

## Governance

- **Amendments:** PR with a rationale for why the previous version was wrong
  or insufficient.
- **Versioning:** Semver.
  - Major — principle removed or materially weakened.
  - Minor — principle added.
  - Patch — wording or clarification.
- **Consultation:** Read by Claude at the start of every `/plan`. Plans that
  violate a principle without addressing the conflict should be rejected on
  review.
