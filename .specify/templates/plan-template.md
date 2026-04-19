# Implementation plan — [FEATURE NAME]

**Feature ID:** NNN-slug
**Spec:** `./spec.md`
**Constitution version consulted:** 0.2.0
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
- **III. Spec-backed, spec-evolving protocol changes:**
- **IV. Explicit security posture on crypto paths:**
- **V. CROPS by default:**
- **VI. L1-preferred:**
- **VII. Local-first by design, degraded-mode by declaration:**
- **VIII. Explicit verification mode:**
- **IX. Minimal dependencies:**
- **X. Demo-app-driven:**

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
- **Red-team cautions addressed:** [reference `red-team.md` C-N entries, or
  *none* / *N/A*]

## Testing strategy

- Unit / integration / contract / end-to-end — what lands where.

## Pre-merge verification gates

Concrete checks that must pass before merge. Number them; list the
verification step for each. Add or drop gates per feature — numbers are
ordinal, not magical.

- **G-1** — Constitution check complete for every principle.
  Verification: review §*Constitution check* above.
- **G-2** — Spec docs updated in the same change (if protocol-touching).
  Verification: `docs/specs/erc-*.md` diff matches §*Public API / wire
  format*.
- **G-3** — Tests cover new behavior, including negative cases.
  Verification: `pnpm test:run` green; `forge test` green if contracts
  touched.
- **G-4** — Security impact addressed (if security-sensitive).
  Verification: §*Security impact* complete; all red-team blockers
  resolved; cautions addressed.

## Rollout

Anything operational: deployments, migrations, deprecations, flags.

## Risks deferred

Risks we consciously chose not to address in this feature. Each has a
justification and a follow-up.

- **[Risk]** — why deferred: [...]; follow-up: [...]

## Alternatives considered

Brief — options evaluated and why this one was chosen.
