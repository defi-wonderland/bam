# `@bam/poster` — follow-up tracker

> Deferred work surfaced by code review of feature `001-bam-poster`. These are
> real gaps, not style nits. Each entry has a concrete fix and a note on
> whether it's merge-blocking, pre-production, or nice-to-have.
>
> **Status:** P1 (FU-1..FU-5) and P2 (FU-6..FU-12) **all shipped**. P3
> (FU-13..FU-17) and meta items (FU-M1, FU-M2) remain open.

## Priority 1 — merge-blocking before any real deployment

### FU-1 ✅ `poster.start()` has no autonomous tick scheduler

**What's broken:** `start()` flips an internal `started = true` flag and returns. No `setInterval`, no per-tag worker, no reorg-watcher timer. In production the Poster never submits unless someone manually hits `POST /flush`. Every test passes because tests call the internal `_tickTag` directly.

**Fix:**

- `createPoster`'s `start()` spawns one timer per tag (`setInterval` or a recursive `setTimeout` driven by `SubmissionLoop.nextDelayMs()` + an idle poll, e.g. 1 s, when the loop returns `'idle'`). On `'retry'` the delay is `nextDelayMs()`; on `'permanent'` the timer stops.
- One reorg-watcher timer on a slower cadence (every block time ≈ 12 s on mainnet; configurable).
- `stop()` clears all timers + awaits in-flight `tick()`.
- Replace the `Object.assign` internal hooks (`_tickTag`, `_tickReorgWatcher`) with an explicit `InternalPoster` interface that extends `Poster`; tests cast to it via a narrow helper.
- Test with vitest fake timers: assert that after `start()`, a single ingested message ends up submitted without any manual tick.

**Scope:** 0.5 day.

### FU-2 ✅ `replacedByTxHash` is never set on resubmission

**What's broken:** `ReorgWatcher.reorgEntry` marks the old row `status='reorged'` with `replacedByTxHash=null`. When the submission loop later resubmits those re-enqueued messages, nothing walks back to update the old row's `replacedByTxHash` to the new tx. Plan §C-12 promises the chain; `listSubmittedBatches` exposes the field; it's always `null`.

**Fix:**

- On a successful `SubmissionLoop.tick`, after inserting the new submitted row, query `listSubmitted({ contentTag, status: 'reorged' })` whose `messageIds` overlap the new batch's `messageIds`, and `updateSubmittedStatus` on each match to set `replacedByTxHash = new.txHash` (and keep status `'reorged'`). If the original pool had multiple reorged entries covering the same messages (double reorg edge case), chain them through — the latest-reorged points at the latest-submitted.
- Extend the reorg e2e test (`test/e2e/reorg.test.ts`) to assert `replacedByTxHash` equals the resubmit tx hash.

**Scope:** 0.25 day.

### FU-3 ✅ Submission success path is split across two `withTxn`s

**What's broken:** `SubmissionLoop.tick` takes one `withTxn` to read the message snapshots, then a second `withTxn` to insert the submitted row + prune pending. Between them nothing holds the lock. With the in-memory `AsyncLock` this is fine (callers serialize), but the Postgres/SQLite paths with multi-process access leave a race window.

**Fix:** collapse into one `withTxn`:

```ts
await store.withTxn(async (txn) => {
  const snaps = await buildSnapshots(txn, picked);
  await txn.insertSubmitted({ ..., messages: snaps });
  await txn.deletePending(picked.map(m => m.messageId));
});
```

**Scope:** 0.1 day.

### FU-4 ✅ HTTP oversized body drains the full payload

**What's broken:** `readBodyBounded` stops buffering after `cap` bytes but keeps consuming the stream to end-of-body. An attacker streaming 10 GB ties up the socket for the duration.

**Fix:** once `oversized` becomes true, write the 413 response headers immediately via `res.writeHead(413)` + `res.end(body)`, then `req.destroy()`. Test with a chunked upload that gets aborted mid-stream.

**Scope:** 0.1 day.

### FU-5 ✅ Factory leaks signer registry on mid-construction failure

**What's broken:** `createPoster` deletes the registry entry only when `reconcileStartup` throws. Later awaits (store creation, loop construction, `poster.start()`) can also throw, leaving the signer address stuck in the registry; the next `createPoster` with that signer rejects spuriously.

**Fix:** wrap the whole body after `signerRegistry.add(address)` in try/catch that deletes the entry on any throw.

**Scope:** 0.05 day.

---

## Priority 2 — pre-production polish

### FU-6 ✅ Memory store skips author case normalization

`SqlitePosterStore` lowercases author keys for `poster_nonces`; `MemoryPosterStore` does not. Cross-store behavior diverges on mixed-case input.

**Fix:** lowercase in `MemoryPosterStore.setNonce` / `getNonce`, matching sqlite. Extend `pool/memory-store.test.ts` with a mixed-case test mirroring the existing sqlite one.

**Scope:** 0.05 day.

### FU-7 ✅ `config.rpcUrl` is dead

`PosterConfig.rpcUrl` is accepted and stored but never read; `extras.rpc` is the only RPC path. Either remove the field or use it to construct a default viem public client when `extras.rpc` is omitted.

**Fix:** remove (simpler — `extras.rpc` is already the canonical surface).

**Scope:** 0.05 day.

### FU-8 ✅ Real concurrency test using two SQLite connections

The C-3 atomicity race currently uses `MemoryPosterStore`, whose `AsyncLock` serializes callers through one Promise chain. That's not a real concurrency test — it proves the in-memory lock works, not that `BEGIN IMMEDIATE` / `SERIALIZABLE` do. A sqlite-backed variant with two parallel database connections hitting the same file would exercise the actual DB locking.

**Fix:** add `test/integration/concurrency-sqlite.test.ts` that opens two `SqlitePosterStore` instances pointing at the same file (real inter-connection locking, not the process-local mutex) and runs the same 50-parallel-ingest assertion. Same for Postgres if a test Postgres container is available.

**Scope:** 0.5 day (includes wiring a test Postgres if desired).

### FU-9 ✅ `build-and-submit.ts` has zero tests

The viem-backed submission wrapper has no unit test. Its error classifier (`/revert/i → permanent`, else `retryable`) is a heuristic that's easy to regress. 

**Fix:** unit test with a mocked `walletClient`. Cases: happy-path (returns `included`), revert error (`permanent`), insufficient-funds-style error (`retryable`), RPC timeout (`retryable`), malformed-tx error (`permanent`). Also assert the trusted setup is loaded lazily (first call loads; second call doesn't reload).

**Scope:** 0.25 day.

### FU-10 ✅ CLI SIGTERM graceful-shutdown subprocess test

T019b's lifecycle test only covers env validation via the `runCli` function (no subprocess). A real SIGTERM test requires invoking the built binary as a subprocess. Currently skipped because `tsx` isn't in devDependencies.

**Fix:** add `tsx` to `packages/bam-poster/devDependencies`, or first `pnpm build` and spawn the compiled binary. Assert SIGTERM → stdout logs "shutting down" → exit 0 within a timeout.

**Scope:** 0.25 day.

### FU-11 ✅ `DEFAULT_MAX_MESSAGE_SIZE_BYTES` is bigger than usable blob capacity minus framing

Currently `120_000`. A single message that large fills a full blob with no room for batch header, author table, or ZSTD overhead. The submission loop would silently skip it because `estimateBatchSize(picked) > blobCapacityBytes`.

**Fix:** derive from `bam-sdk`'s `BLOB_USABLE_CAPACITY - BATCH_HEADER_FIXED_SIZE - framing_fudge`, or set to a rounder `100_000`. Add a test that a message at `DEFAULT_MAX_MESSAGE_SIZE_BYTES - ε` successfully encodes into a blob under default capacity.

**Scope:** 0.1 day.

### FU-12 ✅ Authn on HTTP transport

All endpoints are open. Anyone with network access can ingest, flush, or DoS via rapid flush.

**Fix:** add optional bearer-token auth (env var `POSTER_AUTH_TOKEN`; when set, reject requests missing / with wrong token with 401). Document that the Poster is expected to live behind a reverse proxy; the env-token is a defense-in-depth second gate.

**Scope:** 0.25 day.

---

## Priority 3 — nice-to-have

### FU-13. Rate-limit keys on "claimed" author, not recovered

Plan §C-7 promises "recovered signer address"; the pipeline uses the claimed author from the envelope before any crypto. Functionally similar for non-adversarial callers; an attacker spoofing different authors can amplify their effective rate-limit budget (though each spoofed submit still fails the validator and consumes the spoofed author's budget).

**Options:**

- Leave as-is + document the tradeoff in the validator seam.
- Do ecrecover in-pipeline (almost same cost as verify, so the "cheap gate" argument weakens).
- Key on a fast proof-of-work or hash of `(envelope bytes)` as a weak spam-floor.

**Fix (recommended):** document-as-is for v1. Revisit when / if a production deployment needs stronger spam control.

**Scope:** 0.05 day (docs only).

### FU-14. `messages_json` retention at scale

Submitted batches store the full signed-message payload inline as JSON for reorg re-enqueue. At 1 KB/message × 4096 messages × retention-window rows, that's ~4 MB of JSON per row. Fine for v1 demo load; worth swapping to compressed or length-prefixed binary if the Poster ever runs a high-throughput tag.

**Fix:** gated behind scale (revisit when a tag actually hits 4 MB batch rows).

**Scope:** 0.5 day when triggered.

### FU-15. Windowed pool snapshot in submission loop

`selectBatch` reads the entire tag's pending pool on every tick via `listPendingByTag(tag)` — O(pending). Fine up to low-thousands; wasteful above.

**Fix:** add a cursor-based snapshot (`listPendingByTag(tag, limit, sinceSeq)`, which already exists on `StoreTxn`) and walk windowed. Keep current behavior as the fallback when `picked.length < limit`.

**Scope:** 0.25 day.

### FU-16. HTTP server construction side effect

`new HttpServer({ ..., port: n })` binds inside the constructor. Prefer always-explicit `listen()`.

**Fix:** remove the conditional `listen` in the constructor; force callers to `await server.listen(port, host)`. Update the CLI.

**Scope:** 0.05 day.

### FU-17. `poster.stop()` doesn't coordinate with HTTP in-flight requests

`stop()` closes the store while HTTP handlers may still be invoking it. The CLI's SIGTERM handler gets the order right (server.close → poster.stop → store.close), but an in-process test harness calling `stop()` directly can hit a closed store mid-request.

**Fix:** document the expected order, or have `stop()` accept an optional HTTP server reference and drain it first. Probably document-only.

**Scope:** 0.1 day (docs).

---

## Meta follow-ups

### FU-M1. Merge `NEXT_SPEC.md` into a proper feature spec

`NEXT_SPEC.md` captures the SDK-level ERC-primitive refactor that would remove the v1-wire-format coupling (notably the `timestamp` column). That's its own feature — call it `002-erc-primitive-layer`. Once it lands, FU-7-adjacent cleanup in the Poster becomes possible (drop `timestamp` column, `contents: Uint8Array` end-to-end).

### FU-M2. Schema deviation from `plan.md` to reconcile

`plan.md` §Storage layer documented a `poster_pending` schema without `timestamp` and a `poster_submitted_batches` schema without `messages_json`. Implementation added both. Either:

- Amend `plan.md` in a follow-up PR to match the shipped schema, or
- Drop `timestamp` and `messages_json` as part of FU-M1 (the ERC-primitive refactor makes them unnecessary: `contents: Uint8Array` subsumes `timestamp`; if we split pending retention from submitted-row snapshots differently we may not need `messages_json` either).

Tracked under FU-M1.

---

## Estimated effort to clear P1

FU-1..FU-5: ~1.0 day engineering + ~0.25 day test tightening = **1.25 day total**.

After that, the Poster is production-deployable in the narrow sense (autonomous ticks, chain-linked reorgs, atomic submission, hardened HTTP, clean factory).
