# BAM Constitution

*Version 0.2.0 — draft, unratified*

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

### III. Spec-backed, spec-evolving protocol changes

Changes to wire formats, contract interfaces, or semantics defined in
`docs/specs/erc-8179.md` or `docs/specs/erc-8180.md` are accompanied by
updates to those specs in the same change. Where the implementation
pushes back on or extends an ERC, the spec edit records the rationale
so the learning feeds back into the standard.

**Why:** This repo is a *reference* implementation, and the ERCs are
expected to evolve based on what the reference surfaces. Drift between
code and published spec makes it worse than useless — it misleads.
Silent divergence wastes the feedback the reference is meant to generate.

**In plans:** Protocol-touching features list the spec sections they
modify and include the spec edit in the task list. Extensions or
pushback on an ERC are called out explicitly in the spec edit.

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

### V. CROPS by default

Every feature is evaluated against the four BAM values: **c**ensorship
resistance, **o**pen source, **p**rivacy, **s**ecurity. A design that
weakens any of the four requires explicit justification.

**Why:** These are the properties the protocol exists to deliver. Erosion
rarely happens deliberately — it accumulates through small "acceptable"
tradeoffs. Surfacing them makes the tradeoff reviewable rather than
invisible.

**In plans:** If the feature weakens any CROPS value, name which one and
why the tradeoff is acceptable. If all four are preserved, no extra text
is required.

### VI. L1-preferred

Prefer Ethereum L1 primitives over external infrastructure when both are
viable. Offchain dependencies — services, sidecars, third-party networks
— require justification for why L1 alone is insufficient.

**Why:** Every offchain dependency adds a trust assumption and an
availability failure mode that undermines the guarantees the protocol
exists to provide.

**In plans:** Offchain dependencies are listed with the L1-only
alternative that was considered and rejected.

### VII. Local-first by design, degraded-mode by declaration

Client-facing features declare their behavior when third-party Posters
and Indexers are unavailable. Full offline operation is optional;
silent breakage is not. Acceptable postures:

- **full degraded mode** — the feature still works from the user's
  perspective (e.g. reads from cache, writes queued as pending sync);
  protocol propagation may be deferred, and the degraded state is
  surfaced to the user.
- **partial** — some flows work, some don't; the spec names which and
  how the user is informed of what's unavailable.
- **hard-dep-deferred** — hard dependency on infra; building
  degradation is deferred, with a named follow-up.

**Why:** BAM's censorship-resistance story depends on clients not
locking into centralized availability. Sprint work rarely has time to
build full offline modes, but it can always declare the posture it's
shipping with — and that declaration is what lets review catch
architectural lock-in early.

**In plans:** Client-facing features state their offline posture in one
line (full degraded mode / partial / hard-dep-deferred).
**Hard-dep-deferred** postures name the follow-up issue or milestone in
*Risks deferred*; the other two postures don't require one.

### VIII. Explicit verification mode

Each feature that consumes BAM data declares which verification mode(s)
it supports: **trusted** (rely on a service), **locally verifiable**
(client re-checks from L1), or **proof-verifiable** (ZK or equivalent).

**Why:** Verification mode is the load-bearing trust decision for a BAM
consumer. Leaving it implicit means callers make wrong assumptions
about what the feature actually guarantees.

**In plans:** Consuming features state the mode(s) supported and, if
more than one, which is the default.

### IX. Minimal dependencies

Third-party libraries, services, and infrastructure require explicit
justification. Bias toward the smallest surface area that meets the
requirement. Applies most strongly to client and SDK code reachable
from dApps.

**Why:** Every dependency is a supply-chain, auditability, and
bundle-size cost — amplified in a reference implementation, where
consumers inherit the surface.

**In plans:** New dependencies are named with a one-line justification.
Smaller or built-in alternatives that were considered and rejected are
noted.

### X. Demo-app-driven

Feature value is validated end-to-end through a demo app — Social,
Forum, Blog, or a named successor. Specs name which demo app(s) exercise
the feature.

**Why:** Demo apps are where the protocol's usefulness becomes
observable. A feature no demo can exercise has no evidence it's useful
in the form the protocol is meant to enable.

**In plans:** Feature value is tied to a demo-app flow; absence of such
a flow is called out as a risk.

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
