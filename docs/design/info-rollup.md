# Information rollup

A general-purpose signed-message rollup on BAM (Blob Authenticated Messaging / ERC-8179/8180), with a stake-gated posting model and an optional dispute/slash mechanism for decentralised moderation.

## Scope

Minimal v0. Covers:

- Stake as a Sybil toll for posting
- Dispute-based slashing via Kleros
- A vouch primitive that allows flipping acceptance semantics later

Out of scope for v0: tips/fees, staked endorsement, reputation markets, retroactive de-listing, rollup-native tokens.

## Transport

- Content-tag: `keccak256("info-rollup.v1")`
- Messages signed with `personal_sign` under the ERC-8180 domain
- Batches posted via `BlobAuthenticatedMessagingCore.registerBlobBatch(..., decoder, address(0))`
- `signatureRegistry = address(0)`; authorship verified keylessly via `ecrecover`
- Exposure-compatible encoding (`encodeExposureBatch` / SOB2) is used so any single message can be KZG-proven against its blob — required by the dispute path

## Stake

A single contract, `InfoRollupStake`, holds ETH deposits keyed by address.

- `deposit()` payable — adds to `stakeOf[msg.sender]`
- `requestWithdrawal()` — starts a cooldown (`COOLDOWN = 7 days`)
- `withdraw()` — after cooldown; sends funds to `msg.sender` only (never a recipient parameter)
- `isActive(address)` — `stakeOf >= MIN_STAKE && unlockAt == 0`

`MIN_STAKE` is the Sybil toll (e.g. 0.01 ETH). Cooldown prevents post-and-bail. Any `deposit()` clears a pending withdrawal.

The "withdrawable only to the same account" property follows from never taking a recipient argument — ECDSA binding on the BAM side makes staker and author the same EOA.

## Indexer acceptance rule

For each decoded message from a batch registered at block `B`:

1. Verify signature (`ecrecover` against the ERC-8180 signed hash).
2. Query `InfoRollupStake.stakeOf(author)` and `unlockAt(author)` at block `B` (historical, not head).
3. Accept iff `stake >= MIN_STAKE && unlockAt == 0`.

Evaluating at the batch's inclusion block is what makes independent indexers converge on the same message set.

## Disputes and slashing (optional layer)

`InfoRollupDisputes` is an ERC-792 Arbitrable contract wired to a Kleros arbitrator. A challenger can open a dispute against a specific `messageId` by:

1. Providing the message bytes + signature + KZG proofs that the bytes live in the referenced blob at the declared FE range.
2. Posting a challenge bond plus Kleros's arbitration cost.
3. The contract calls `stake.freeze(author)` and `arbitrator.createDispute(...)`.

Kleros's `rule()` callback resolves to:

- **Violates policy** → `stake.slash(author, SLASH_AMOUNT, challenger)`; return challenger bond; unfreeze remainder.
- **Does not violate** → forfeit challenger's bond; unfreeze.
- **Refuse** → refund both; unfreeze.

The policy that jurors adjudicate against is an off-chain document pinned to an immutable `policyHash` on the disputes contract. Mutating the policy means deploying a new contract.

The stake contract exposes `freeze` / `unfreeze` / `slash` to a single immutable slasher address set at construction. No governance, no upgrades.

## Vouches and trust scores

A vouch is a signed BAM message under a second content-tag (`keccak256("info-rollup.vouches.v1")`) whose payload points at an author address with an optional `revokes` field (a `bytes32` referencing the BAM message hash of a prior vouch from the same sender to nullify it).

No new contract. Vouchers must be staked authors — indexers apply the same `isActive` check to the voucher at the vouch message's batch block and ignore vouches from inactive addresses. Vouches from slashed addresses carry zero weight.

### Seed-anchored trust scores

Raw vouch counts are gameable: an attacker can stake two accounts and have each vouch for the other, forming a closed self-vouching circle. Trust scores address this by making trust a flow commodity that originates only from a known genesis set.

A small set of genesis addresses G is committed on-chain as an immutable `bytes32 seedSetHash` stored in `InfoRollupStake` at deployment — a content-addressed pointer to a published list (e.g. an IPFS document). Indexers use G as the root of trust and compute a score for every author using a damped graph walk:

- Genesis addresses start with score 1.0.
- Each outgoing vouch distributes a fraction of the voucher's score to the recipient (`score × dampingFactor`, e.g. 0.85 per hop).
- An author's final score is the sum of weighted trust received across all incoming paths from G.
- Closed cliques with no path to G converge to score 0, regardless of internal vouch density.
- Revocation (via `revokes`) removes the edge immediately; scores are recomputed from the full vouch graph at each evaluation.

This is equivalent to a personalised PageRank seeded at G. The computation is entirely off-chain from the vouch event stream; no contract changes are needed. `seedSetHash` is the only centralisation point — it is immutable, content-addressed, and verifiable on-chain.

In v0, vouches and trust scores are a hint — frontends may display scores but acceptance does not depend on them.

## Default-show vs default-hide

v0 is **default-show**: the only gate on visibility is that the author was staked at batch block.

If spam pressure later requires it, indexers can flip to **default-hide** by adding one condition to the acceptance rule:

```
accept iff isActive(author) at batchBlock
       AND trustScore(author) >= T
```

where `trustScore` is the seed-anchored score described above and `T` is a reader-configurable threshold. No migration, no contract change — the vouch events are already on-chain by then. `T` and the damping factor are reader-policy knobs rather than protocol constants.

The flip itself is a coordination problem among indexers and frontends, not an on-chain event. Different frontends may flip at different times or choose different `K` values; readers who disagree can run their own indexer. That pluralism is the sovereign-read model working as intended.

## Sovereign posting and reading

- **Posting without a relay**: author sends one EIP-4844 transaction with the blob and a `registerBlobBatch` call. Requires a prior (or bundled) `deposit()` to the stake contract.
- **Reading without an indexer service**: frontend scans `BlobBatchRegistered` by `contentTag`, fetches blobs from Beacon/archivers, verifies signatures, and adds one historical `eth_call` per author-per-batch against `InfoRollupStake`. Disputes add a second `eth_call` against `InfoRollupDisputes` when displaying slash badges.

The rollup's identity is the tuple `(contentTag, decoder, stakeAddress, seedSetHash, disputesAddress, policyHash)` — all either immutable or content-addressed, all discoverable on-chain. `disputesAddress` and `policyHash` are `address(0)` / `bytes32(0)` if the optional disputes layer is not deployed.

## Open questions

- `MIN_STAKE`, `SLASH_AMOUNT`, `CHALLENGE_BOND` calibration. Should be set together so one bad post burns a meaningful fraction of stake and challengers can net profit on valid calls.
- `COOLDOWN` length vs Kleros resolution latency. Freeze handles the in-dispute case; cooldown only bounds the undisputed case.
- Where slashed funds beyond the challenger reward should go (burn vs treasury vs author pool).
- Policy document structure. Needs to be specific enough for Kleros jurors to adjudicate consistently without imposing quality judgments the rollup doesn't want to make.
- Trust score damping factor and threshold `T` calibration. Lower damping spreads trust further from the seed set; higher damping concentrates it. `T` trades off accessibility for new authors against spam resistance.
- Genesis set size and selection. Too small and the seed set is a single point of failure; too large and it becomes unwieldy to agree on at launch. Three to five addresses is a reasonable starting point.
- Whether vouches should also be able to target `messageId` (per-post quality signal) in addition to `address` (per-author endorsement).
- Spam protection at the disputes layer itself: the challenge bond covers frivolous challenges, but mass-challenge griefing against a single author may still need rate limits.
