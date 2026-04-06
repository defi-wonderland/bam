# On-chain blog comment section

An on-chain comment system for a blog, with everything on L1 and decentralized moderation.

This doc covers the reading and writing infrastructure: how comments get authored, batched, posted, indexed, and displayed. Content moderation is a separate problem (TBD below).

## Architecture

Built on BAM (Blob Authenticated Messaging), reusing the `SocialBlobsCore` contract. Comments are signed with `personal_sign` (ECDSA) so users can just use their existing wallet. BLS aggregation could be added later if volume justifies the UX cost.

### System overview

```mermaid
graph LR
    C[Commenter<br/>wallet] -->|signed msg| R[Relay]
    R -->|blob tx + registerBlob| E[Ethereum L1]
    R -->|pending msgs| F[Blog Frontend]
    E -->|events + blobs| I[Indexer]
    I -->|comments API| F
    R -.->|can be same service| I
```

### Posting flow (happy path)

```mermaid
sequenceDiagram
    participant C as Commenter
    participant R as Relay
    participant L1 as Ethereum L1
    participant I as Indexer
    participant F as Frontend

    C->>C: personal_sign(message)
    C->>R: submit signed message
    R->>F: serve as "pending"
    R->>L1: batch + blob tx (registerBlob)
    L1-->>I: SocialBlobsCore event
    I->>I: fetch blob, decode
    F->>I: query confirmed comments
    F->>R: query pending comments
```

### Fallback flow (no server)

```mermaid
sequenceDiagram
    participant C as Commenter
    participant L1 as Ethereum L1
    participant F as Frontend

    C->>C: personal_sign(message)
    C->>L1: post blob directly (1 comment per blob)
    F->>L1: scan SocialBlobsCore events
    F->>F: fetch blobs, decode, display
```

### Actors

- **Commenter** signs messages with their wallet via `personal_sign` (ECDSA). No key registration needed.
- **Relay** accepts signed messages, batches them into blobs, posts to L1. Untrusted: it can censor or delay, but can't forge anything because messages are pre-signed. Anyone can run one.
- **Indexer** watches `SocialBlobsCore` events, fetches and decodes blobs, serves comment history via API. Can be the same service as the relay. Also untrusted: it can omit comments but can't forge them.
- **Blog frontend** displays comments. Two modes: query the server (fast) or self-index from chain (slow, expensive, but works without any infrastructure).

### Operating modes

The server is the fast path. The frontend fallback exists so the system doesn't hard-depend on anyone's infrastructure.

**With server (fast path):**
1. Commenter signs a message with `personal_sign`, referencing a blog post topic ID
2. Submits to a relay
3. Relay serves the message immediately as "pending" via API
4. Relay batches pending messages, posts a blob, calls `SocialBlobsCore.registerBlob()` with the blog post topic in calldata
5. Indexer (can be the same service) watches events, fetches/decodes blobs, serves comment history
6. Frontend queries the indexer for confirmed comments and the relay for pending ones

**Without server (escape hatch, not a primary UX):**
1. Commenter signs a message with their wallet
2. Frontend posts a blob directly (one comment per blob, roughly $1-5 at current blob gas prices)
3. Frontend scans `SocialBlobsCore` events and fetches blobs from the Beacon API or archivers
4. Works, but too expensive for regular use

### On-chain exposure

Not needed in the happy path. Comments are read by decoding blobs off-chain.

Whether on-chain exposure is needed depends on the moderation design (TBD). KZG exposure requires per-message field element alignment in the blob, which constrains compression and reduces how many comments fit per blob. If moderation can work without exposure, blobs can be compressed more aggressively.

### Relay design

The relay's trust model is liveness only. It can't forge signatures, only censor or delay.

Multiple relays can operate for the same blog. If one censors or goes down, commenters resubmit to another. Relays serve queued messages via API before they're batched into a blob. Signatures are verifiable client-side, so pending comments are already authenticated, just not yet committed to chain.

Optionally, relays can gossip pending messages to each other so any relay can batch them.

### Topic routing

Relays tag blobs via `SocialBlobsCore.registerBlob()` calldata with a topic identifier (blog post URL or hash). The frontend filters events by topic to find relevant blobs.

### Blob archival

Blobs get pruned from the Beacon chain after ~18 days. A few ways to keep them around:

- Relays archive blobs as a side effect of posting them
- The blog frontend pins blobs to IPFS as it reads them (readers become archivers)
- Third-party blob archivers (Blobscan, EthStorage)

Multiple relays means multiple archives.

### Pending message edge cases

- Message stays pending too long: frontend flags it, commenter can resubmit to another relay
- Relay goes down before batching: commenter still has their signed message, resubmits elsewhere
- Duplicate submission across relays: dedup by message hash (author + nonce + content)

## Content moderation

TBD. The requirements: decentralized (blog author doesn't want to moderate), high quality discussion, offense/defense asymmetry favoring defense. Kleros is a candidate. This design will also determine whether on-chain exposure is needed (see above).

## Existing BAM infrastructure

| Component | Role |
|---|---|
| `SocialBlobsCore` | Blob registration + topic tagging (event indexing) |
| `bam-sdk` | Message encoding, blob construction |

## Assumptions

Infrastructure:
- Blob gas stays cheap enough for comment batching to be viable
- Beacon API is accessible and reliable enough for the frontend fallback
- 280-character default message limit works for blog comments (configurable, wire format supports up to 65535 bytes)

Trust model:
- Nonce in message format prevents relay replay attacks
- Dedup by `author + nonce + content` is sufficient, and independent indexers will converge on the same state
- Topic tags in `registerBlob()` calldata need no access control (anyone can tag any topic)

Lifecycle:
- 18-day blob pruning window is long enough for at least one archiver to grab the data
- Fallback mode (one comment per blob) is usable as an escape hatch, if expensive

Moderation:
- Content moderation can be layered on after the base protocol ships, without needing to change the registration flow

## Open questions

Upstream (impacts BAM SDK):
- The 280-character message limit (`MAX_CONTENT_CHARS`) is now configurable via `encodeMessage()` options. But the wire format only uses a 2-byte content length when the compressed flag is set. `FLAG_EXTENDED_CONTENT` exists but isn't wired up, so uncompressed messages >255 bytes need a wire format fix.
- Topic routing has no spam protection. Anyone can tag junk blobs for any topic via `registerBlob()`. Should filtering happen at the contract level or application level?

This spec:
- Topic ID format: blog post URL hash vs. sequential ID vs. something else
- Relay incentives: do commenters pay a small fee, or is relay operation altruistic/self-hosted?
- Archival guarantees: is relay-side archival enough, or do we need an explicit DA commitment?
- Moderation contract design (see above)
- Identity/reputation: ENS integration? Any signal beyond raw addresses?
- Threading: how does the message format handle replies and parent references?
- Cost analysis: per-comment cost at different volumes, sensitivity to blob gas prices. Needs a worked example at a specific snapshot (blob gas price, comments per blob, ETH price)
