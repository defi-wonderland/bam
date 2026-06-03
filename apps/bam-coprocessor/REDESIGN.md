# Circuit 1 — Per-Message Proof Redesign

## Why

The current circuit commits `M = sha256(all verified messages concatenated)`. To check
that a specific message is covered by M you must supply every other message in the batch
and reconstruct M from scratch. That works today only because every blob carries exactly
one message. Once a blob carries N messages — which the pack planner in `bam-poster`
already supports — per-message verification requires N messages to verify 1.

The fix: replace M with the ERC-8180 `messageHash` in the public output. The circuit
proves one message and commits its identity directly. Verification becomes a single
keccak256 call: `keccak256(sender ‖ contentTag ‖ nonce_be8 ‖ contents) == proof.messageHash`.

Circuit 2 is wound down. The Groth16 C1 proof alone is the deliverable — cheap to verify
in a browser or on-chain, self-contained per message.

---

## New Circuit 1 design

### Inputs (stdin)

```
chain_id:  u64
batch:     ReaderBatch   (single batch, not Vec)
msg_index: u32
```

### Steps

Same 6 steps as before. The only change is in step 5 and 6:

- **Step 5** — `assert!(verify_ecdsa(...))` for the message at `msg_index` only.
  Panic on invalid signature instead of silently dropping. Call `decode_batch` on the
  full segment first (validates trailing-bytes invariant, consistent with bam-reader).
  Then assert `msg_index < messages.len()`.

- **Step 6** — compute `message_hash = keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)`.
  No sort, no M.

### Public output (152 bytes, fixed)

```
[0..8]     chain_id       u64 LE
[8..40]    versioned_hash 32 bytes
[40..72]   content_tag    32 bytes
[72..74]   start_fe       u16 LE
[74..76]   end_fe         u16 LE
[76..84]   block_number   u64 LE
[84..88]   tx_index       u32 LE
[88..92]   msg_index      u32 LE
[92..112]  sender         20 bytes
[112..120] nonce          u64 LE
[120..152] message_hash   32 bytes
```

Fixed size, no variable per-batch sections. `start_fe`/`end_fe` are public outputs by
construction — the open soundness issue (ISSUES.md §1) is resolved.

---

## Files to change

### `program-reader/src/main.rs`

- stdin: read `ReaderBatch` (not `Vec<ReaderBatch>`) + `u32` msg_index
- Remove outer loop over batches
- Remove `all_verified` accumulation
- After decode: `assert!(msg_index < messages.len())`
- `assert!(verify_ecdsa(...))` on `messages[msg_index]` only
- Compute `message_hash` via `compute_message_hash` from lib
- New commit block (152-byte layout above)
- Remove `compute_message_commitment` call

### `lib/src/lib.rs`

- Add `pub fn compute_message_hash(sender: &[u8;20], content_tag: &[u8;32], nonce: u64, contents: &[u8]) -> [u8;32]`
  — `keccak256(sender ‖ content_tag ‖ nonce.to_be_bytes() ‖ contents)`
- Keep `compute_message_commitment` — still used by prove-app sanity check until C2 is removed

### `script/src/lib.rs`

- Remove `BATCH_STRIDE` constant
- Remove `PublicValues` / `BatchMeta` structs and `parse_public_values` / `print_public_values`
- Add `MessagePublicValues` struct (11 fields matching layout above)
- Add `parse_message_public_values(raw: &[u8]) -> MessagePublicValues`
- Add `print_message_public_values`
- Keep `AppPublicValues` / `parse_app_public_values` until C2 code is removed

### `script/src/bin/prove-reader.rs`

- Add `--msg-index <u32>` arg (default 0)
- Read first entry from cache (or add `--batch-index` if multi-batch cache needed)
- `stdin.write(&batch)` + `stdin.write(&msg_index)` (remove loop)
- Update output JSON to use `MessagePublicValues`

### `script/src/bin/prove-from-reader.rs`

- Add `--msg-index <u32>` arg
- Fetch one batch by `--content-tag` + either `--tx-hash` or `(--block-number, --tx-index)`
- Remove multi-batch accumulation

### `script/src/bin/show-proof.rs`

- `--circuit reader` branch: parse with `parse_message_public_values`
- Display: show `message_hash`, `sender`, `nonce`, `versioned_hash`, `msg_index`

### `apps/bam-coprocessor-demo/src/main.ts`

- `decodePublicInputs`: parse 152-byte fixed layout (no `BATCH_STRIDE` loop)
- Delete `computeM`
- Add `computeMessageHash(post)`:
  `keccak256(fromHex(post.sender) ‖ TWITTER_TAG_BYTES ‖ nonce_be8 ‖ encodeContents(post))`
  Requires `@noble/hashes` for browser-side keccak256
- `doVerify` step 4: compute `messageHash` from the one displayed post, compare to `pi.messageHash`
- Proof index: key entries by `message_hash` (bam-indexer already returns this field)
- Update `Post` interface to include `message_hash: string`
- Update tampered-entry demo: show that changing any field of the post produces a different `messageHash`, not a different M

---

## What breaks

- All existing proof artifacts (`c1_proof*.bin`, `public/proofs/proof_*.json`) — different circuit, different VK
- C1 VK hash in `program-app/src/main.rs` — must re-run `print-vk` after circuit changes
- `results.json` — old multi-batch execute output, no longer relevant
- `prove-app.rs` M sanity check — M is gone from C1; decommission with C2

---

## What is fixed

- **ISSUES.md §1** (`start_fe`/`end_fe` soundness gap) — resolved, they're public outputs
- No more M reconstruction from all batch messages to verify one
- Public output is fixed-size and simpler to parse
- Multi-tag blobs work naturally — each segment is an independent proving domain

---

## Correctness notes

**Full batch decode required.** Call `decode_batch` on the full segment; do not early-exit
at `msg_index`. The trailing-bytes check in `decode_batch` mirrors bam-reader's rejection
behavior — a message from a malformed batch should not be provable.

**ECDSA: assert, not filter.** Invalid signature at `msg_index` → proving fails. The host
should pre-validate ECDSA before submitting to the network to avoid burning proving fees.

**nonce encoding.** `messageHash` uses nonce as 8-byte big-endian, same as the EIP-712
struct hash. Document in lib and in the browser function. A mismatch here causes silent
verification failure.

---

## Tradeoffs

**Cost at scale.** N messages per blob → N independent Groth16 proofs, each with full KZG
cost (~25M cycles). Current design: 1 KZG per blob regardless of N. At current traffic
(≤1 message per app per blob) the cost is identical. If one segment ever carries many
messages, the two-tier "blob certificate + message certificate" architecture amortises KZG
across all N.

**No global feed checkpoint.** M was a provable snapshot of the feed state. Per-message
proofs are independent — there is no proof of "the complete timeline is exactly these N
tweets." That requires a separate aggregation design and is out of scope for this PoC.

---

## Circuit 2

Circuit 2 (`program-app/`) is wound down. The C1 Groth16 proof is the deliverable.
The files (`program-app/`, `prove-app.rs`) can be deleted once the C1 redesign is
validated end-to-end. `CIRCUIT2.md` is kept as a historical record.

---

## Implementation order

1. `lib/src/lib.rs` — add `compute_message_hash`
2. `program-reader/src/main.rs` — per-message circuit
3. `script/src/lib.rs` — `MessagePublicValues`, remove `BATCH_STRIDE`
4. `prove-reader.rs` — `--msg-index`, single-batch stdin
5. `show-proof.rs` — new display
6. Execute mode: verify `message_hash` matches bam-indexer's `message_hash` for block 10932896
7. `print-vk` — re-derive C1 VK hash
8. Prove on Succinct network (Groth16)
9. `main.ts` — new `decodePublicInputs`, `computeMessageHash`, proof index by message_hash
10. Browser test end-to-end
11. Delete `program-app/`, `prove-app.rs`, stale proof artifacts
