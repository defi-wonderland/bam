# Red-team — [FEATURE NAME]

**Feature ID:** NNN-slug
**Spec:** `./spec.md`
**Status:** draft

> **What this document is:** adversarial review of the spec. Surfaces what
> would break, what would leak, and what an attacker or sloppy caller
> would exploit. Blockers fold back into `spec.md`; cautions surface in
> `plan.md`.

## Trust boundaries

At each step of the feature, who is trusted and who is not? Where does
untrusted input become trusted? List boundaries explicitly.

- **[Step or interface]** — trusted: [...]; untrusted: [...]; how crossed:
  [...]

## Code path audit

| Path / symbol | Current behavior | Change with this feature | Risk |
| --- | --- | --- | --- |
|   |   |   |   |

Include every function reachable from the change, not only those directly
modified. If a caller now sees different semantics, list it.

## Adversarial scenarios

For each: the scenario, the failure mode, and whether the spec as currently
written prevents it.

- **[Scenario name]**
  - Attacker / sloppy caller: [...]
  - What they try: [...]
  - Expected outcome: [...]
  - Actual outcome per current spec: [...]
  - Verdict: prevented / blocker / caution

Categories to consider (add or drop per feature):

- Forged or malformed signatures / KZG proofs.
- Replayed or truncated blobs.
- Wrong `chainId` or fork.
- Gas griefing, oversized inputs, pathological compression ratios.
- Caller passes `undefined`, `0x`, or wrong encoding.
- Browser vs Node behavioral divergence.
- Precision or rounding (BigInt vs Number).

## Blockers

Issues that prevent `/plan` from starting. Each blocker lists the proposed
`spec.md` edit that resolves it. Start with `_None._` below. **When you
add your first entry, delete the `_None._` line** — the two should never
appear together. Mark resolved blockers `[x]` once the spec edit has
landed.

_None._

<!-- Format when entries exist (delete _None._ above first):
- [ ] **B-1** — [issue]
  - **Spec edit:** [what to change in `spec.md`]
-->

## Cautions

Issues that must be addressed in `plan.md` (not the spec). Same rule:
start with `_None._`; **delete it when you add your first entry**.

_None._

<!-- Format when entries exist (delete _None._ above first):
- [ ] **C-1** — [issue]
  - **Plan treatment:** [what the plan must say or gate]
-->
