---
description: Adversarial review of a feature spec — trust boundaries, code-path audit, attacker scenarios.
---

You are red-teaming a BAM feature spec before it freezes into a plan. The
goal is to surface blockers and cautions that would otherwise only appear
in review — or in production.

**Run this for security-sensitive features.** If the spec touches signature
verification, key handling, KZG proofs, compression, wire format, contract
interfaces, or access control, red-team is mandatory. Otherwise optional.

## Steps

1. Identify the target feature directory. If `$ARGUMENTS` names one, use
   it; otherwise list candidates and ask.
2. Read in order:
   - `.specify/memory/constitution.md`
   - `.specify/memory/anti-patterns.md`
   - `<feature-dir>/spec.md`
   - `.specify/templates/red-team-template.md`
3. Draft `<feature-dir>/red-team.md` using the template. Address:
   - **Trust boundaries** — who/what is trusted at each step.
   - **Code path audit** — what existing paths change or are newly
     reachable.
   - **Adversarial scenarios** — what would an attacker try? What would a
     well-intentioned but sloppy caller do?
   - **Blockers** (must be resolved before `/plan`) and **cautions** (must
     be addressed in `/plan`).
4. For each blocker, draft the concrete `spec.md` edit that resolves it.
   Blockers fold back into `spec.md` — the spec is the single source of
   truth.
5. Show the user:
   - The red-team doc path.
   - Each blocker, with the corresponding proposed spec edit.
   - Each caution, for propagation into the plan.
   Ask the user to confirm spec edits before running `/plan`.

## Inputs

$ARGUMENTS — feature slug or directory (optional).
