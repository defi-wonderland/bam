---
description: Execute a feature's tasks.md, one task at a time with verification.
---

You are executing a BAM feature's `tasks.md`. Work through tasks in order,
verifying each one before moving on.

## Steps

1. Identify the target feature directory. If `$ARGUMENTS` names one, use it;
   otherwise list candidates and ask.
2. Read `<feature-dir>/tasks.md`.
3. For each unchecked task, in order:
   a. Announce which task you're starting.
   b. Make the changes the task describes.
   c. Run the task's verification step.
   d. If verification passes, check the box in `tasks.md`. Do not delete
      the line.
   e. If verification fails, stop. Report the failure and the last
      successful task. Do not silently move on.
4. When all tasks are checked, run the final full-suite task if one exists,
   then report:
   - What changed (summary of diff).
   - What tests ran and their status.
   - Any follow-ups surfaced during implementation.

## Rules

- Do not modify `spec.md`, `plan.md`, or `constitution.md` during
  `/implement`. If a task requires it, that's a signal to stop and return
  to `/plan`.
- Do not add tasks beyond what's in `tasks.md`. If you discover missing
  work, surface it as a follow-up.

## Inputs

$ARGUMENTS — feature slug or directory (optional).
