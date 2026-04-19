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
   - `.specify/memory/anti-patterns.md`
   - `<feature-dir>/spec.md`
   - `<feature-dir>/red-team.md` — **if present**. If the feature is
     security-sensitive and this file is missing, stop and suggest the
     user run `/red-team` first.
   - `.specify/templates/plan-template.md`
3. If `spec.md` still has unresolved clarifications, stop and surface
   them. Treat any `[NEEDS CLARIFICATION` occurrence anywhere in the
   file as unresolved — inline markers are authoritative, and the
   *Open questions* section is just an index that may drift. Do not
   invent answers.
4. If `red-team.md` exists, check its *Blockers* section. Ignore the
   template's format-hint block (an HTML comment starting with
   `<!-- Format when entries exist`). If any *other* HTML comment in
   the section contains `- [ ] **B-` (a checkbox-bullet inside a
   comment), treat it as a commented-out blocker: stop and ask the user
   to resolve or convert it to real markdown before planning. A blocker
   is unresolved if the remaining content contains an unchecked bullet
   matching `- [ ] **B-N** …` with real content. A section whose only
   remaining content is `_None._` has no blockers. Stop if any real
   blocker is unresolved — it must fold into `spec.md` before the plan
   is drafted.
5. Draft `<feature-dir>/plan.md` using the template. For each constitution
   principle, state *Not applicable*, *Satisfied*, or *Conflict* with
   reasoning — never skip a principle silently. If `red-team.md` exists,
   reference its cautions in *Security impact* and set the pre-merge
   verification gates accordingly.
6. Show the user the plan path and highlight:
   - Any constitution conflict (requires discussion before `/tasks`).
   - Any spec doc (`docs/specs/erc-*.md`) that will need edits.
   - Security-sensitive changes and red-team cautions.
   - The pre-merge verification gates chosen for this feature.

## Inputs

$ARGUMENTS — feature slug or directory (optional).
