---
description: Break an implementation plan into an ordered, testable task list.
---

You are converting a BAM feature's `plan.md` into a `tasks.md` that
`/implement` will execute.

**Each task must be small and verifiable.** If a task can't state a concrete
verification step (a test command, a diff to inspect, a build that must
pass), it's too vague — split it.

## Steps

1. Identify the target feature directory. If `$ARGUMENTS` names one, use it;
   otherwise list candidates and ask.
2. Read in order:
   - `<feature-dir>/spec.md`
   - `<feature-dir>/plan.md`
   - `.specify/templates/tasks-template.md`
3. If `plan.md` still has unresolved constitution conflicts, stop.
4. Draft `<feature-dir>/tasks.md` using the template. Order tasks so each
   one is verifiable against the codebase state left by the previous task.
   Include tasks for:
   - Spec doc updates (if the plan requires them).
   - Test additions.
   - A final full-suite run.
5. Show the user the task list and ask them to review before `/implement`.

## Inputs

$ARGUMENTS — feature slug or directory (optional).
