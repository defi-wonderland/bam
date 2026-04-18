---
description: Turn a feature spec into an implementation plan, consulting the constitution.
---

You are drafting an implementation plan for a BAM feature whose spec already
exists. Your job is to produce a reviewable `plan.md` that describes HOW the
feature will be built.

**Constitution is load-bearing here.** Every plan must include a
*Constitution check* section addressing each principle explicitly.

## Steps

1. Identify the target feature directory under `docs/specs/features/`.
   If `$ARGUMENTS` names one, use it; otherwise list candidates and ask.
2. Read in order:
   - `.specify/memory/constitution.md` — note the version.
   - `<feature-dir>/spec.md`
   - `.specify/templates/plan-template.md`
3. If `spec.md` still has unresolved *Open questions*, stop and surface
   them. Do not invent answers.
4. Draft `<feature-dir>/plan.md` using the template. For each constitution
   principle, state *Not applicable*, *Satisfied*, or *Conflict* with
   reasoning — never skip a principle silently.
5. Show the user the plan path and highlight:
   - Any constitution conflict (requires discussion before `/tasks`).
   - Any spec doc (`docs/specs/erc-*.md`) that will need edits.
   - Security-sensitive changes.

## Inputs

$ARGUMENTS — feature slug or directory (optional).
