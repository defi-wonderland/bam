# Circuit 2 — bam-twitter coprocessor

Recursively verifies the Circuit 1 proof inside SP1, applies bam-twitter
deduplication and aggregation, and commits to a timeline root R.

---

## What it proves

Given Circuit 1's proof (M = sha256 of verified messages over blobs on L1):
- The message set behind M, filtered by TWITTER_TAG, deduplicated by (sender, nonce),
  sorted canonically, hashes to timeline root R.

R traces back to L1 without re-running KZG or ECDSA in Circuit 2.

---

## Measured results (execute mode, Sepolia)

| Field | Value |
|-------|-------|
| M (C1 anchor) | `0x6cb1ce626cfcb014807ca66751398d97f1477f6d0eacc5d1cfbc987bb29c799c` |
| Timeline root R | `0x30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5` |
| Tweets | 9 (all 9 messages in the C1 scope are bam-twitter posts) |
| C2 cycles | 1,444,801 (~160× cheaper than C1's 230M) |

---

## stdin layout

```
write_proof(c1_compressed_proof, pk1.vk)   ← prove mode only; ignored by executor
chain_id:          u64
c1_public_values:  Vec<u8>   — raw Circuit 1 public output bytes
messages:          Vec<VerifiedMessage>
```

`write_proof` must come before all other writes. The executor ignores it.

---

## Public outputs

```
[0..8]   chain_id     (u64 LE)
[8..40]  M            (32 bytes — C1 message commitment, integrity anchor)
[40..72] R            (32 bytes — timeline root sha256)
[72..76] tweet_count  (u32 LE)
```

---

## Guest steps (`program-app/src/main.rs`)

```
Step 1 — verify_sp1_proof(c1_vk_hash, [0u8;32])
         No-op in execute mode; in prove mode enforces the recursive proof.

Step 2 — parse c1_chain_id and M from c1_public_values[0..40]
         assert chain_id == c1_chain_id

Step 3 — compute_message_commitment(messages) and assert == M

Step 4 — filter messages where contents[0..32] == TWITTER_TAG
         decode_twitter_contents per message, drop malformed

Step 5 — build_timeline: sort by (block_number, tx_index, msg_index)
         deduplicate by (sender, nonce) — first occurrence wins
         compute R = sha256(canonical timeline)

Commit: chain_id || M || R || tweet_count
```

---

## TWITTER_TAG

```
keccak256("bam-twitter.v1") =
  0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718
```

---

## Compressed proof — required for prove mode

Circuit 1 must be proved with `.compressed()` so Circuit 2 can recursively
verify it. Both `prove-reader` and `prove-from-reader` already do this.

```bash
# Circuit 1 — compressed proof
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x<key> \
cargo run --release --bin prove-reader -- \
  --prove --chain-id 11155111 \
  --cache ../bam-indexer/cache/batches.json \
  --output c1_proof.bin

# Circuit 2 — recursive proof
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x<key> \
cargo run --release --bin prove-app -- \
  --prove --c1-proof c1_proof.bin \
  --reader-url https://bam-reader.fly.dev \
  --output c2_proof.bin
```

---

## VK management for prove mode

`verify_sp1_proof` in `program-app/src/main.rs` currently has a `[0u32; 8]`
placeholder. This is safe for execute mode (the call is a no-op) but must be
replaced with the real C1 verifying key hash before prove mode produces a
cryptographically sound recursive proof.

**Step 1 — print the C1 VK hash:**

```bash
cd apps/bam-coprocessor
cargo run --release --bin print-vk
```

Output:
```
C1 verifying key hash (u32 x8):
[...actual values...]

Paste into program-app/src/main.rs:
    sp1_zkvm::lib::verify::verify_sp1_proof(&[...], &[0u8; 32]);
```

**Step 2 — replace the placeholder in `program-app/src/main.rs`:**

```rust
// Before:
sp1_zkvm::lib::verify::verify_sp1_proof(&[0u32; 8], &[0u8; 32]);

// After (paste print-vk output):
sp1_zkvm::lib::verify::verify_sp1_proof(&[1234u32, 5678u32, ...], &[0u8; 32]);
```

**Step 3 — rebuild:**

`build.rs` recompiles the guest automatically on the next `cargo build` or
`cargo run`. No manual action needed.

The VK is stable across different inputs — it only changes when Circuit 1's code
changes. Run `print-vk` again after any `program-reader/src/main.rs` edit.

---

## E2E test sequence

```bash
cd apps/bam-coprocessor

# 1. Circuit 1 execute (produces results.json)
cargo run --release --bin prove-reader -- \
  --execute --chain-id 11155111 \
  --cache ../bam-indexer/cache/batches.json \
  --output results.json

# 2. Circuit 2 execute (reads results.json, fetches messages from bam-reader)
cargo run --release --bin prove-app -- \
  --execute --chain-id 11155111 \
  --c1-output results.json \
  --reader-url https://bam-reader.fly.dev

# Expected output:
#   M sanity check passed ✓
#   chain_id:             11155111
#   message commitment M: 0x6cb1ce6...
#   timeline root R:      0x30126f1...
#   tweets:               9
```

---

## Known issues

- **`[0u32; 8]` VK placeholder** — safe for execute mode, must be replaced via
  `print-vk` before network prove mode produces a sound recursive proof.
- **`start_fe`/`end_fe` not in C1 public outputs** — not a blocker for this
  demo; all 9 cached batches are correctly bounded, but a verifier cannot
  confirm which segment of the blob was processed.
- **ZSTD not supported** — none of the current batches use ZSTD compression,
  but any production blob that does is outside Circuit 1's scope.
