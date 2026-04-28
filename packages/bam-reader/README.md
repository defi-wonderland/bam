## bam-reader

Node-only service that scans L1 for `BlobBatchRegistered` events,
fetches blob bytes (beacon API primary, Blobscan fallback), recomputes
the versioned hash on every source, dispatches decode and per-message
signature verification (zero-address shortcut to the SDK; non-zero →
bounded `eth_call` to the named contract), and persists the resulting
`BatchRow`/`MessageRow` values into the shared `bam-store` substrate.
A separate reorg-watcher loop reconciles in-window confirmed batches
against the canonical chain. Two operating modes: `serve` (live-tail
daemon) and `backfill --from N --to M` (one-shot historical run).

### Meaning of `confirmed` per Poster configuration

The `(decoder, signatureRegistry)` pair on every `BlobBatchRegistered`
event is submitter-controlled. The Reader treats whichever address the
submitter named as authoritative for the purposes of producing a
`confirmed` row. Three configurations are reachable via the Poster's
`POSTER_BATCH_PROFILE` selector:

- **`POSTER_BATCH_PROFILE=default` — `decoder = 0x0`, `registry = 0x0`.**
  SDK fast path on both sides. `confirmed` means: "the SDK's local
  `decodeBatch` parsed the payload, and the SDK's local `verifyECDSA`
  accepted each row's signature against the recovered owner address."
- **`POSTER_BATCH_PROFILE=canonical-registry` — `decoder = 0x0`,
  `registry = ECDSARegistry`.** SDK decode, chain-endorsed verify.
  `confirmed` means: "the SDK's local `decodeBatch` parsed the payload,
  and `ECDSARegistry.verifyWithRegisteredKey` returned `true` — i.e.,
  the signature recovers either to the named owner directly *or* to an
  owner-self-registered delegate." `ECDSARegistry` is permissionless:
  any address can register a delegate for *its own* address (gated by
  proof-of-possession). The endorsement statement is therefore
  recover-or-delegate, not "the named author is authenticated to a
  human or organization." Identity-strength claims belong to a
  consumer-side allowlist (Indexer's job, not the Reader's).
- **`POSTER_BATCH_PROFILE=canonical-full` — `decoder = ABIDecoder`,
  `registry = ECDSARegistry`.** Full on-chain dispatch.
  `confirmed` means everything `canonical-registry` means, *plus*
  "the on-chain `ABIDecoder` accepted the blob payload as
  well-formed `abi.encode(Message[], bytes signatureData)`."

#### Chain-id-mismatch behavior (expected, not regression-tested)

If the Reader's RPC and the Poster's `POSTER_CHAIN_ID` are pointing at
different chains, the named `(decoder, registry)` addresses won't
resolve to live contracts on the Reader's chain. The expected outcome,
following the existing dispatch behavior, is that the bounded
`eth_call` reverts (no contract at that address), the row counts as
`skippedDecode` / `skippedVerify`, and *no* `confirmed` row is
produced — misconfiguration surfaces in counters, never on the wire
as a silent downgrade. This path is not currently covered by an e2e
regression test; operators should not treat the description as a
guarantee until it is.

#### RPC quota note (canonical configurations)

`canonical-registry` and `canonical-full` move dispatch onto L1 RPC:
canonical-registry adds one `eth_call` per *message* for verify;
canonical-full also adds one `eth_call` per *batch* for decode. Per-call
gas + wallclock caps remain in force (`READER_ETH_CALL_GAS_CAP`,
`READER_ETH_CALL_TIMEOUT_MS`) but do not bound rate. Operators on
canonical configurations should bring their own RPC endpoint with
appropriate quota — at least double the call rate of the default
profile.
