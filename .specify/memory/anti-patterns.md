# BAM spec-kit anti-patterns

Things we've learned not to do. Each entry lists the anti-pattern, why it
bites, and what to do instead. Referenced by `/red-team` and `/plan`. Add
to this file as we accumulate lessons — it is meant to grow.

## Process

### Skipping red-team on security-sensitive changes

**Don't** jump from `/specify` to `/plan` when the feature touches
signatures, keys, proofs, compression, wire format, contract interfaces,
or access control.

**Why:** confirmation bias is strongest right after spec drafting. Review
tends to read what the author meant to write, not what's actually there.
Red-team is an explicitly adversarial second pass.

**Instead:** run `/red-team`, fold blockers into `spec.md`, then `/plan`.

### Writing tests after implementation

**Don't** implement the feature first and add tests "to document" what
you built.

**Why:** tests written after the fact test what the code *does*, not what
the spec *requires*. Bugs the author didn't anticipate stay uncaught.

**Instead:** interleave test tasks with implementation tasks in
`tasks.md`. Don't batch tests at the end.

### Leaking internal error messages to callers

**Don't** return `err.message` or raw exception text across a public
interface (SDK error, event, revert reason).

**Why:** leaks internal paths, dependency versions, or configuration. Stable
callers also can't branch on free-form text.

**Instead:** map internal failures to stable error codes or typed errors.
Log the original details internally.

### Bypassing CI gates to unblock yourself

**Don't** merge with `--admin` or silently skip required checks.

**Why:** CI gates exist because someone found a class of failure worth
preventing. Silent bypass means the next person inherits a weaker gate.

**Instead:** surface the blocker to reviewers, get explicit sign-off, and
record the reason in the PR or a follow-up issue.

### Error handling for impossible scenarios

**Don't** wrap internal calls in `try/catch` or add validation when the
preconditions are already guaranteed by the caller or the framework.

**Why:** defensive code hides real bugs — the branch written for the
"impossible" case is the one that fires silently when an invariant you
didn't think about gets violated. That branch also needs tests nobody
writes.

**Instead:** validate at the trust boundary (user input, on-chain data,
external API) and trust internal code. If an invariant must hold, assert
it loudly.

## BAM-specific

### Adding storage to core contracts without rationale

**Don't** add a mapping, array, or state read to
`BlobAuthenticatedMessagingCore` or another core contract without an
explicit justification in `plan.md`.

**Why:** violates constitution principle I. Core state breaks
reconstructibility of the protocol from calldata + events.

**Instead:** put the state on an ancillary contract (registry, exposer),
or justify the core-state choice in the plan's *Constitution check* with a
mitigation (e.g. explicit getter semantics, upgrade path).

### Adding Node-only dependencies reachable from the browser entrypoint

**Don't** import `c-kzg`, `node:fs`, `node:crypto`, or similar at the top
level of a file that `bam-sdk/browser` can reach.

**Why:** violates principle II. The browser build fails or silently
polyfills, and dApp consumers hit runtime errors.

**Instead:** scope Node-specific code to the Node entrypoint and provide a
browser implementation (or a scoped exclusion documented in the plan).

### Changing wire format without updating the ERC spec in the same change

**Don't** adjust batch encoding, message encoding, or exposure format in
the SDK/contracts without touching `docs/specs/erc-8179.md` or
`docs/specs/erc-8180.md` in the same PR.

**Why:** violates principle III. The published spec is the reference;
drift makes the reference actively wrong.

**Instead:** include the spec edit in `tasks.md`. If the implementation
is leading the spec, the spec update is part of the feature.

### Adding an offchain dependency without considering L1

**Don't** introduce a Poster, Indexer, relay, or other third-party
service as a required dependency without documenting the L1-only
alternative that was considered and rejected.

**Why:** violates principle VI. Every offchain dependency is a trust
assumption and an availability failure mode. If L1 alone would work,
the offchain path is pure loss.

**Instead:** state the L1-native design that was considered and why it
was insufficient, in the plan's *Packages and files touched* or
*Alternatives considered*.

### Undocumented offline posture on client-facing features

**Don't** ship a client-facing feature whose behavior when Posters or
Indexers are unreachable is undeclared. Hanging, opaque errors, or
silent unusability in that case — with no spec-level acknowledgement —
is the failure mode.

**Why:** violates principle VII. The sin is silent brittleness, not
the absence of degradation. A hard dependency on third-party infra is
acceptable for sprint work; hiding it from review is not.

**Instead:** in `spec.md`, declare the offline posture (full degraded
mode / partial / hard-dep-deferred). If degraded, describe what still
works and how the user is informed. If hard-dep-deferred, name the
follow-up in the plan's *Risks deferred*.

### Landing crypto changes without a *Security impact* section

**Don't** ship signature, key, proof, or compression changes with
`plan.md` missing the *Security impact* section.

**Why:** violates principle IV. An unaudited project cannot rely on
"everything is reviewed carefully."

**Instead:** fill in *Invariant affected*, *What could break*, and *Test
coverage specifically exercising this*. If `/red-team` ran, its blockers
and cautions feed this section directly.
