# BAM Poster — Requirements (draft for `/specify`)

> Rough requirements for the first BAMstack component: a **Poster**.
> Purpose: feed into `/specify` to produce a formal feature spec.

## What

A standalone **Poster** service/library that accepts Blob Authenticated Messages from clients, batches them, and submits them to Ethereum L1 as a blob-carrying transaction via the BAM Core contract. It also exposes the currently-pending (not-yet-submitted) messages so clients can render them before they land on-chain.

## Why

The BAMstack idea draft identifies the Poster as a core primitive ("batches up messages and posts them as blobs, while making pending messages available to clients"). Today, posting logic is baked into the `message-in-a-blobble` Next.js demo app (`apps/message-in-a-blobble/src/app/api/post-blobble/route.ts`). We want a reusable, app-agnostic Poster that multiple BAM applications can depend on, and that demo apps can swap in as a thin caller.

## In scope

1. **Message ingest** — accept a well-formed BAM message, validate it, enqueue it.
2. **Pending pool** — durable store of accepted-but-not-yet-submitted messages; survives restart; readable by clients.
3. **Batch submission** — on a configurable policy (size / time threshold), encode the pending messages into a BAM batch, build the blob, compute KZG commitments, and submit a type-3 tx calling `registerBlobBatch` on BAM Core.
4. **Status / observability** — expose poster wallet balance, last-submitted batch, pending count, cooldown.
5. **Transport-agnostic core** — ingest and pending-read are a library API. HTTP is the first adapter; the architecture must allow a Waku (or equivalent gossip/pubsub) adapter to drop in later without changing the core.
6. **Validator hook** — pluggable `MessageValidator` interface. Default implementation: well-formedness + ECDSA signature verification (reuse `verifyECDSA` from `bam-sdk`). Apps can supply stricter validators (e.g. staking, identity, content-tag policy).
7. **Batch policy hook** — pluggable `BatchPolicy` interface controlling *when* to submit. Default: trigger when pending size OR age crosses a threshold.
8. **Signer abstraction** — default: local ECDSA key from config. Interface must allow KMS / remote signer later.

## Out of scope (for this iteration)

- Incentives / payment for posting (explicitly out of scope in the BAMstack draft).
- Production hardening: audits, MEV protection, multi-region HA.
- ZK proofs of batch correctness (the ZK coprocessor is its own component).
- Identity / staking module integration beyond the validator hook.
- Waku or other gossip-layer integration (only the seam for it must exist).
- Standalone archiver functionality (separate component in the draft).
- Reorg handling beyond "resubmit if not included after N blocks" (treat deeper reorg handling as an open question, not a requirement).

## Non-functional requirements

- **Restart-safe**: ingested-but-not-yet-submitted messages are not lost across process restart.
- **Transport-agnostic**: no HTTP types leak into the core ingest/pool/submitter API.
- **L1-preferred, local-first** (per BAMstack principles): avoid hard dependencies on third-party services in the default path. An operator should be able to run the Poster against their own Ethereum RPC and a local DB.
- **CROPS-aware**: censorship-resistant (no implicit filtering beyond declared validators), open source, no unnecessary data collection.
- **Graceful degradation**: if L1 submission is failing (gas, RPC down), ingest should keep accepting messages and expose them via the pending-read API so clients still see activity.
- **Reuse over reinvent**: batch encoding, KZG, compression, contract calls come from `packages/bam-sdk`; Poster does not re-implement these.

## Interfaces (first cut — refine in `/specify`)

- **Ingest**: `submit(message: BamMessage) → { accepted, messageId } | { rejected, reason }`
- **Pending read**: `listPending({ since?, contentTag?, limit? }) → BamMessage[]`
- **Validator**: `validate(message) → { ok: true } | { ok: false, reason: string }`
- **BatchPolicy**: `shouldSubmit(pool: PendingPool, now: Date) → boolean`
- **Signer**: `signTx(tx) → signedTx` (or `address` + `signMessage`)
- **Status**: `status() → { walletAddress, balanceWei, pendingCount, lastBatch?: { blockNumber, blobVersionedHash, txHash, at } }`

## Demo integration

The existing `apps/message-in-a-blobble/src/app/api/post-blobble/route.ts` becomes a thin HTTP adapter that calls the new Poster library. The demo must continue to work end-to-end after the extraction.

## Open questions (capture, don't decide now)

- Should the pending pool expose an eventual-ordering guarantee, or is "best-effort plus on-chain ordering" enough?
- Per-message vs per-batch validation — does the validator ever need batch-level context (e.g. cross-message rate limits)?
- How does the Poster expose which messages ended up in which blob after submission — do clients learn via the pending API disappearing, a submitted-batch feed, or both?
- Reorg depth to tolerate before considering a batch "final" from the Poster's perspective.
- Do we need a per-content-tag pending queue, or a single queue with filtering at read time?
- What does "graceful degradation" look like if the submitter wallet runs out of ETH — hold, alert, both?

## Success criteria

- New `packages/bam-poster` library exists with the interfaces above and a working HTTP adapter.
- `message-in-a-blobble` demo runs end-to-end on the extracted Poster with no user-visible regression.
- Swapping the default validator for a stricter one requires no changes to the core.
- A (stub) Waku adapter can be added later by implementing only the ingest adapter — no changes to pool or submitter.
