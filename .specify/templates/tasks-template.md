# Tasks — [FEATURE NAME]

**Feature ID:** NNN-slug
**Plan:** `./plan.md`
**Status:** draft

> **What this document is:** The ordered, testable checklist that
> `/implement` will execute. Each task should be small enough to land in a
> single commit and verifiable on its own.

## Tasks

- [ ] **T001** — [action]
  - Files: `path/to/file.ts`
  - Verification: `pnpm --filter bam-sdk test:run path/to/test`

- [ ] **T002** — [action]
  - Files:
  - Verification:

- [ ] **TNNN** — Update `docs/specs/erc-8180.md` §[section] (if protocol
      change)
  - Verification: diff against `plan.md`'s wire-format section

- [ ] **TNNN** — Run full suite: `pnpm test:run` and
      `cd packages/bam-contracts && forge test`
  - Verification: green

## Notes for `/implement`

- Work tasks in order unless a task explicitly marks itself parallelizable.
- Update this file as tasks complete — check the box, don't delete the line.
- If a task's verification fails, stop and surface the failure — do not
  silently proceed to the next task.
