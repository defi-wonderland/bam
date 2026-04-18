# Implementation plan — [FEATURE NAME]

**Feature ID:** NNN-slug
**Spec:** `./spec.md`
**Constitution version consulted:** 0.1.0
**Status:** draft

> **What this document is:** HOW we'll build what `spec.md` describes.
> No task list yet — that's `tasks.md`.

## Constitution check

For each principle in `.specify/memory/constitution.md`, state either:
- *Not applicable* (and why), or
- *Satisfied* (and how), or
- *Conflict* (and the justification + mitigation).

- **I. Stateless core:**
- **II. Dual-runtime SDK:**
- **III. Spec-backed protocol changes:**
- **IV. Explicit security posture on crypto paths:**

## Architecture

One diagram or a short prose description of where this feature lives, which
packages it touches, and how the pieces fit together.

## Packages and files touched

- `packages/bam-sdk/...` — [why]
- `packages/bam-contracts/...` — [why]
- `apps/...` — [why]
- `docs/specs/...` — [why, if applicable]

## Public API / wire format

Signatures, ABIs, encodings, or message formats introduced or changed.
Be explicit — `/tasks` reads this to decide what to build.

## Runtime targets (SDK features only)

Which runtimes does this support, and how does the other behave?

## Security impact (if security-sensitive)

- **Invariant affected:**
- **What could break:**
- **Test coverage specifically exercising this:**

## Testing strategy

- Unit / integration / contract / end-to-end — what lands where.

## Rollout

Anything operational: deployments, migrations, deprecations, flags.

## Alternatives considered

Brief — options evaluated and why this one was chosen.
