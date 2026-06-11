# Waku broadcast layer

A real-time broadcast layer for BAM messages using [Waku](https://docs.waku.org/), sitting between the moment an author signs a message and the moment a batcher posts it in an EIP-4844 blob. This doc covers the message lifecycle, the roles involved, and how frontends merge pending (Waku) and confirmed (indexer) data.

## Status

Design sketch. Depends on the same prerequisites as the comment-section and info-rollup designs (topic binding, domain-separated signing, keyless ECDSA registry). Waku-specific integration has not been prototyped.

## Motivation

Both the comment-section and info-rollup designs describe a relay that accepts signed messages, serves them as "pending," and batches them into blobs. The relay's gossip behaviour is left unspecified ("relays may optionally gossip pending messages to each other"). This leaves three gaps:

1. **Relay discovery.** How does an author find a relay? Hardcoded URLs, DNS, something else?
2. **Relay censorship.** A single relay can silently drop messages. The only recourse is "resubmit elsewhere" -- which requires knowing where "elsewhere" is.
3. **Pending message delivery.** Frontends poll the relay's HTTP API for pending messages. If the relay is down, pending messages are invisible.

Waku fills all three by replacing the bespoke relay-to-relay gossip with a decentralised pub/sub mesh. Authors publish directly to the mesh; anyone listening receives the message; no single node can suppress it.

## Why Waku over alternatives

We considered four alternatives:

- **Plain HTTP relay federation.** Relays know about each other via a static list or DNS and forward messages over HTTP. Simple, no new dependency, but you're building your own gossip protocol (peer management, dedup, failure handling) and censorship resistance is only as good as your relay list.
- **Nostr relays.** Client-relay WebSocket model, large ecosystem. But relays are islands (no mesh gossip by default), BAM and Nostr message formats diverge (needs a wrapper), and adopting Nostr brings opinions about identity and content types that don't align with BAM.
- **Raw libp2p GossipSub.** Waku is built on GossipSub. Using it directly strips away Store (short-term retrieval for late joiners), Filter (bandwidth-efficient light clients), and RLN (spam protection). You'd end up rebuilding the useful parts of Waku.
- **Do nothing.** Keep the single-relay model and specify gossip later. Ships faster, but the single-relay censorship and liveness problems persist, and you defer the same decision.

Waku is a packaged solution for gossip + light clients + spam protection + short-term storage, without buying into a different social protocol's conventions. The main cost is the dependency on Waku's network and node software. That cost is mitigated by keeping the Waku layer optional (see Sovereign operation).

## Architecture

Three roles, cleanly separated:

```
Author signs message
       |
       v
  +-------------+
  | Waku network |  <-- real-time broadcast, ephemeral (hours)
  |  (gossip)    |     anyone can listen, anyone can relay
  +------+-------+
         | batcher subscribes
         v
  +-------------+
  |   Batcher    |  <-- collects from Waku, posts blobs to L1
  +------+-------+
         |
         v
  +-------------+
  |  Ethereum L1 |  <-- BlobSegmentDeclared + BlobBatchRegistered
  +------+-------+
         | indexer watches events
         v
  +-------------+
  |   Indexer    |  <-- fetches blobs, verifies, serves confirmed API
  +-------------+
```

### Roles

| Role | Reads from | Writes to | Trust assumption |
|------|------------|-----------|------------------|
| **Batcher** | Waku (subscribe) | L1 (blob tx) | Liveness only. Can delay or censor but not forge. Replaceable by any other batcher. A batcher that delays longer than Store retention effectively censors -- the message expires from Store and the author's only recourse is direct blob submission. |
| **Indexer** | L1 (events + blobs) | API (REST/GraphQL), optionally Waku | Completeness only. Can omit but not forge. Replaceable; sovereign reading is the escape hatch. |
| **Waku network** | Authors (publish) | Everyone (gossip) | Network-level. Censoring requires controlling the mesh. RLN rate-limits spam. |

The **frontend** is a Waku light node (Filter + Light Push) that also queries an indexer for confirmed and historical data.

### What changed from the relay model

The current relay role bundles four concerns: message ingestion, pending message serving, relay-to-relay gossip, and batching. With Waku:

- **Message ingestion** moves to Waku (author publishes via Light Push).
- **Pending message serving** moves to Waku (frontends subscribe via Filter).
- **Relay-to-relay gossip** is just Waku Relay -- it's what the protocol does.
- **Batching** remains. This is the batcher role: listen on Waku, collect messages, post blobs. It's the only part that requires a dedicated service.

## Message lifecycle

### Phase 0: Author publishes

Author signs the message (ECDSA, domain-separated per ERC-8180). Instead of HTTP-POSTing to a specific relay, the author publishes to Waku via Light Push on the appropriate content topic (see Content topics below). The payload is the raw BAM wire-format bytes -- already self-authenticating, nothing to wrap.

### Phase 1: Real-time broadcast

The message propagates across the Waku gossip mesh. Anyone subscribed to the content topic receives it immediately: frontends, batchers, other interested parties. Frontends verify the signature client-side and display the message as "pending."

### Phase 2: Batching

A batcher subscribes to one or more content topics, collects messages into a queue, and when a batch threshold is met (size, time, or both), posts the blob to L1 via `registerBlobBatch`. Batching latency should stay well below Waku Store retention to avoid the soft-censorship window described in the roles table. As a guideline, Store retention should be at least 2x the expected batching interval.

The batcher validates signatures before including a message (cheap, stateless). Policy checks (stake, disputes) are left to the indexer -- the batcher doesn't need L1 state and doesn't make acceptance decisions beyond basic validity.

### Phase 3: L1 confirmation

The batcher's blob transaction confirms. `BlobSegmentDeclared` and `BlobBatchRegistered` events are emitted. Same as existing designs.

### Phase 4: Indexing

The indexer watches events, fetches the blob, decodes, verifies signatures, applies acceptance rules (stake check at batch block for info-rollup, signature-only for comments), and stores confirmed messages. Same as existing designs.

### Phase 5: Confirmation feedback

How the frontend learns that a pending message is now confirmed:

- **Primary path**: frontend polls the indexer API. Simple and necessary anyway for historical queries.
- **Optimisation**: the indexer publishes confirmation events to a Waku topic (see Content topics). Frontends that want real-time confirmation subscribe to both the message topic and the confirmation topic. Note: confirmation messages received via Waku are advisory only. A malicious or buggy indexer could publish false confirmations. Frontends MUST verify confirmation against L1 data or a trusted indexer API response before promoting a message to confirmed status.

Either way, the frontend promotes the message from pending to confirmed using the merge logic described below.

## Content topics

Waku content topics follow the format `/{application}/{version}/{topic-name}/{encoding}`.

| Purpose | Content topic | Publisher | Subscriber |
|---------|---------------|-----------|------------|
| Messages for a content tag | `/bam/1/msg-{contentTag hex}/proto` | Author | Frontend, batcher |
| Batch confirmations (optional) | `/bam/1/confirm-{contentTag hex}/proto` | Indexer | Frontend |
| Batcher coordination (optional) | `/bam/1/batching-{contentTag hex}/proto` | Batcher | Other batchers |

The `contentTag` in the Waku topic matches the `contentTag` used in `registerBlobBatch` and `BlobSegmentDeclared`. One BAM content tag = one Waku topic. Waku's autosharding maps content topics to network shards automatically.

**Topic cardinality.** The number of content tags determines the number of Waku topics. Autosharding maps topics to a fixed number of network shards (currently 8 on the default Waku network), so many topics may land on the same shard. Light clients using Filter will receive cross-talk from unrelated topics sharing a shard. At tens to low hundreds of active topics this is manageable. At thousands or more, application-level topic aggregation (grouping related content tags into a single Waku topic and demuxing client-side) may be necessary. The expected cardinality depends on how applications assign content tags -- one per blog, one per post, one per comment thread -- and should be estimated before deploying to production.

## Merging pending and confirmed data

The frontend has two streams feeding it the same logical messages with an overlap window: a message arrives via Waku immediately, then the same message appears as confirmed from the indexer minutes later.

### Dedup key

`(contentTag, messageHash)` where `messageHash = keccak256(sender, nonce, contents)`. This is stable across pending and confirmed states because it's computed from the message alone, with no dependency on which blob the message lands in.

The full `messageId` per ERC-8180 (`keccak256(author, nonce, contentHash)`) includes the batch's `contentHash`, which doesn't exist until the message is batched. `messageHash` is the common factor across both phases.

### Merge logic

```
for each message from either source:
  key = (contentTag, messageHash)
  if key exists:
    keep the higher-confidence version (confirmed > pending)
  else:
    insert
```

### Ordering

- **Confirmed messages**: ordered by chain position (`blockNumber`, `logIndex`, intra-batch position). Deterministic across indexers.
- **Pending messages**: ordered by Waku arrival time. Non-deterministic, advisory only. To improve consistency across frontends, authors should include a monotonic sequence number per (author, contentTag) in the message. Frontends can sort pending messages by author-asserted sequence within each author, falling back to arrival time for cross-author ordering.

When a message transitions from pending to confirmed, it takes its place in the chain-derived order. The frontend should display pending and confirmed messages in visually distinct sections to avoid visible reordering.

### Stale pending messages

A pending message that never confirms could mean:
- No batcher picked it up (liveness failure).
- A batcher excluded it (invalid signature, or a smart batcher filtered it).
- The indexer rejected it (unstaked author in info-rollup).

The frontend should flag messages that remain pending for longer than a threshold (e.g., N blocks after the most recent confirmed batch for the same content tag). The exact threshold is an application-level decision -- comments can be more tolerant than info-rollup. This is a frontend UX concern, not a protocol-level retry. The protocol does not re-broadcast or re-queue stale messages; the author must resubmit if needed.

### Reconnection

When a frontend reconnects after being offline:

1. Query the indexer for confirmed messages (authoritative, ordered). This is the base.
2. Query Waku Store for recent pending messages (best-effort). This is the overlay.
3. Dedup the overlay against the confirmed set using `messageHash`.

Indexer first, Waku Store second. The confirmed set is the source of truth; pending messages fill in what hasn't been batched yet.

## Batcher duplication

Multiple batchers subscribing to the same content topic will collect the same messages. If two batchers post blobs containing the same message, the indexer deduplicates on `messageHash` and the first by chain order wins. Correctness is not affected; duplication is a gas cost issue only.

Mitigations, in increasing order of complexity:

1. **Reactive eviction.** Every batcher watches L1 for `BlobBatchRegistered` events and evicts confirmed `messageHash`es from its pending queue. Shrinks the duplication window to roughly one batch interval.
2. **Optimistic announcement.** After submitting a blob transaction, the batcher publishes the included `messageHash`es to the coordination topic. Other batchers evict those from their queues. Small race window remains on near-simultaneous submissions.

In early deployments, one or two batchers per content tag is the expected case. Duplication is rare and cheap. More elaborate coordination (claim windows, batcher rotation) can be added later if batcher competition increases, but that's a separate design problem tied to batcher incentives.

## Batcher incentives (out of scope)

Batcher incentives -- who pays blob gas, whether authors attach tips, whether a fee market emerges -- are out of scope for this design and will be addressed in a separate document. Until an incentive mechanism exists, the operating assumption is operator-funded batchers: the blog owner, application developer, or protocol foundation runs a batcher and absorbs the gas cost. This is viable for early low-traffic deployments but does not scale. The Waku broadcast design does not depend on a specific incentive model; any fee mechanism can be layered on top without changing the message lifecycle or content topic structure.

## Spam protection

Two complementary layers:

- **Waku layer**: RLN (Rate Limiting Nullifier) rate-limits publishing per epoch. Prevents flooding the gossip mesh. Privacy-preserving -- no need to reveal identity to rate-limit.
- **Application layer**: stake-gating (info-rollup), signature verification (comments), or other acceptance rules enforced by the indexer. These don't apply at the Waku level -- the gossip mesh carries everything, and the indexer filters.

RLN protects the transport. Application rules protect the content. They don't overlap.

**RLN readiness.** As of this writing, RLN is deployed on Ethereum Sepolia for testing but does not have a production mainnet deployment. Until mainnet RLN is available, the system operates in a degraded mode: no transport-layer rate limiting, with spam mitigation relying entirely on application-layer filtering (signature verification, stake checks) at the indexer. This is acceptable for low-traffic early deployments but becomes a problem at scale. The mainnet RLN timeline should be tracked as an external dependency.

## Sovereign operation

The Waku layer is an optimisation for real-time broadcasting, not a hard dependency. Both existing fallback paths still work:

- **Posting without Waku**: author sends an EIP-4844 transaction directly, with blob and `registerBlobBatch` call. Expensive but sovereign. Same escape hatch described in comment-section and info-rollup designs.
- **Reading without Waku**: frontend queries the indexer API for confirmed messages only. Loses real-time pending visibility but still has the full confirmed history.
- **Reading without an indexer**: frontend scans `BlobSegmentDeclared` events on-chain, fetches blobs, decodes, verifies. Fully trustless, same sovereign-read path as existing designs.

## Indexer discovery

Waku solves the write path (getting messages out) and the real-time read path (subscribing to pending). The historical read path -- querying confirmed, ordered, policy-filtered messages -- still requires an indexer, and frontends need to find one.

Approaches, layered by complexity:

- **v0: out-of-band.** The application hardcodes its indexer URL or publishes it via ENS, a well-known URI, or project documentation.
- **Later: Waku-based discovery.** Indexers publish heartbeats to a discovery topic (`/bam/1/indexers-{contentTag hex}/proto`) with their API endpoint, block range coverage, and a signature. Frontends collect these and can query multiple indexers for redundancy.
- **Always: sovereign read.** The on-chain fallback that works without any indexer.

## Persistence tiers

With Waku in the architecture, messages pass through three persistence layers:

| Tier | Duration | Guarantee | Operated by | Purpose |
|------|----------|-----------|-------------|---------|
| Waku Store | Hours to days | Best-effort, not guaranteed | Waku Store nodes (community or application-operated) | Catch-up for late-joining frontends on recent pending messages |
| Beacon chain blobs | ~18 days | Protocol-guaranteed within pruning window | Ethereum validators | Primary data availability for indexers |
| Archivers (Blobscan, EthStorage, etc.) | Long-term | Depends on archiver | Third-party archival services | Permanent record; same open question as existing designs |

Waku Store fills a specific gap: a frontend that connects after a message was broadcast but before it's in a blob can still retrieve it. It's not a replacement for blob archival.

## Existing BAM infrastructure used

| Component | Role |
|-----------|------|
| `BlobAuthenticatedMessagingCore` (ERC-8179/8180) | Blob registration with indexed `contentTag` |
| `bam-sdk` | Message encoding, signing, blob construction |
| ERC-8180 `messageHash` / `messageId` | Dedup across pending and confirmed states |

## Waku network maturity

The Waku network is live but early-stage. The public node count is small and unquantified, nodes are volunteer-run with no service incentivization mechanism, RLN is testnet-only, and the JS SDK (`@waku/sdk`) is pre-stable (0.0.x). Production usage is limited to a handful of projects (Status, RAILGUN, Graphcast). The network should be treated as functional but not battle-tested.

**Self-operated nodes.** To avoid depending on volunteer node coverage, application operators should run a small number of nwaku nodes (2-3 is sufficient for early deployments). Self-operated nodes guarantee Store retention, relay density, and Filter/Light Push service for the application's content topics regardless of public network size. These nodes participate in the broader mesh normally -- if the public network grows, the application benefits from increased decentralization without configuration changes. Until then, self-operated nodes are a soft single point of failure, but this is strictly better than the current single-relay model and the sovereign operation fallbacks still apply.

## Assumptions

- Waku's network, supplemented by self-operated nodes, is reliable enough for the pending-message path. If Waku is unavailable, the system degrades to blob-only posting (no real-time, but not broken).
- RLN membership is available on a network the target audience can access (currently Ethereum Sepolia). Mainnet RLN is an external dependency (see Spam protection).
- Waku Store nodes retain messages long enough to cover the gap between broadcast and blob confirmation (minutes to low hours is sufficient). Self-operated Store nodes make this controllable rather than best-effort.
- Batcher competition is low in early deployments. Reactive eviction from L1 events is sufficient to control duplication.
- Autosharding handles the mapping from content topics to network shards without manual configuration.

## Open questions

- **Waku message format.** Should the Waku payload be raw BAM wire-format bytes, or a protobuf wrapper containing the BAM bytes plus metadata (e.g., the author's preferred batcher, a tip amount)? Raw is simpler; a wrapper is more extensible.
- **RLN membership scope.** One RLN membership per author globally, or per content tag? Global is simpler; per-tag prevents a spammer on one topic from being rate-limited on another.
- **Confirmation topic semantics.** What exactly does the indexer publish on the confirmation topic? Minimal (`txHash` + `messageHash`es) or rich (full confirmed message data with ordering)? Minimal is simpler but forces a second indexer query for details.
- **Waku Store duration.** How long should Store nodes retain messages? Long enough to cover batching latency (minutes) is the minimum. Longer retention overlaps with blob availability and may not add value.
- **Light client viability.** Can browser-based frontends run Waku light nodes (Filter + Light Push over Secure WebSocket) with acceptable performance and bundle size? Needs prototyping.
