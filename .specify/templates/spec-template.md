# Feature spec — [FEATURE NAME]

**Feature ID:** NNN-slug
**Status:** draft
**Author:** [name]
**Date:** YYYY-MM-DD

> **What this document is:** WHAT we're building and WHY. No implementation
> decisions — those belong in `plan.md`.

## Problem

What is wrong today, or what capability is missing? One or two paragraphs.
Who feels the pain, and in what scenario?

## Goals

- Concrete, user-visible outcomes. Each one should be observable after the
  change ships.

## Non-goals

- What this feature explicitly does *not* do. Prevents scope creep in `/plan`.

## User stories

- As a [role], I want to [action], so that [outcome].

## Acceptance criteria

- [ ] Observable behavior that demonstrates the goal is met.
- [ ] Include negative cases where relevant (e.g. "invalid input rejected
      with specific error").

## Trust boundary *(fill in if security-sensitive)*

Where does untrusted input enter, and where is it considered trusted? Name
the boundary; don't hand-wave.

## Code path audit *(fill in if touching existing protocol code)*

Analysis of **existing** code the feature will touch. This is research,
not design: name the existing contracts, modules, and functions that
change or become reachable. Do not invent new APIs or file locations here
— those belong in `/plan`.

| Existing path / symbol | Current behavior | Change with this feature |
| --- | --- | --- |
|   |   |   |

Include every function reachable from the change, not only those directly
modified.

## Adversarial scenarios *(fill in if security-sensitive)*

Briefly list attacker or sloppy-caller scenarios the spec must prevent.
Full adversarial analysis happens in `/red-team`; this section captures the
ones already known during spec drafting.

- **[Scenario]** — [what they try]; [what the spec ensures happens]

## Open questions

- Anything unresolved. `/plan` should not start until these are answered or
  explicitly deferred. If `/red-team` runs, it will expand this list before
  folding blockers back into the sections above.
