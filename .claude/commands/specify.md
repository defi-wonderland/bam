---
description: Draft a feature spec (WHAT and WHY) from a short description.
---

You are drafting a feature spec for the BAM project. The user has given a
short description of what they want. Your job is to expand it into a
reviewable `spec.md` following the template.

**Do not write implementation details.** No package names, file paths, API
signatures, or library choices. Those belong in `/plan`. If you find
yourself making technical decisions, stop — ask the user or defer to the
plan.

## Steps

1. Read `.specify/templates/spec-template.md` for the required structure.
2. Run `.specify/scripts/create-new-feature.sh "<short-slug>"` to create the
   feature directory and get its path. The script prints the directory on
   stdout.
3. Fill in the spec at `<feature-dir>/spec.md` using the template. Keep
   *Open questions* section honest — surface real ambiguity rather than
   inventing answers.
4. Show the user the spec path and a summary of what's in it. Ask them to
   review before running `/plan`.

## Inputs

$ARGUMENTS — short natural-language description of the feature.
