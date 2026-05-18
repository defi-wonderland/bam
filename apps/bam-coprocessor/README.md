# bam-coprocessor

EIP-4844 blobs expire from Ethereum's consensus layer in roughly 18 days. Without a proof, verifying a processed message feed requires trusting the operator who ran the pipeline or replaying computation from raw blob bytes that may no longer exist. This coprocessor removes that dependency. It runs two circuits inside the [SP1](https://docs.succinct.xyz) zkVM to produce a bam-twitter timeline root R that traces cryptographically back to the KZG commitments permanently stored on L1.

The implementation is a demo that runs against a small set of Sepolia blobs pre-downloaded as a local cache. The specific blobs were fetched as a working example and are not a constraint of what the circuits can prove.

---

## Why two circuits

The BAM reader pipeline concentrates most of its cost in KZG opening verification and ECDSA signature checking. Both are expensive operations in a zkVM, and both only need to run once per blob set regardless of how many applications consume the same data. Splitting this work into a dedicated circuit makes it reusable across apps.

Circuit 1 handles the expensive verification and commits to M, a sha256 over the canonical verified message stream. Circuit 2 is the app layer: it recursively verifies the Circuit 1 proof inside the zkVM, trusting M without re-running KZG or ECDSA, then runs whatever logic the app needs on the verified message set. Each BAM app ships its own Circuit 2; they all share the same Circuit 1.

| | Circuit 1 | Circuit 2 |
|---|---|---|
| Does | KZG verify, ECDSA verify, decode | Recursive C1 verify + app logic |
| Cost | KZG + ECDSA (expensive) | App-dependent (no KZG/ECDSA) |
| Input | Raw EIP-4844 blobs | Verified messages (from C1) |
| Output | M (message commitment) | App-defined state root |
| Run | Once per blob set | Once per app |

---

## Workspace layout

The workspace contains four crates. `program-reader/` is the Circuit 1 guest and `program-app/` is the Circuit 2 guest, both compiled for the SP1 zkVM. `lib/` holds the shared types and pipeline functions compiled for both host and guest. `script/` contains the five host binaries (`prove-reader`, `prove-from-reader`, `prove-app`, `print-vk`, `show-proof`).

---

## How it works

### Circuit 1

Circuit 1 proves that a set of messages was correctly derived from specific EIP-4844 blobs by running the full BAM reader pipeline inside the zkVM. For each blob in the batch:

1. It **anchors the blob to L1** by asserting the versioned hash against sha256 of the KZG commitment.
2. It **verifies the KZG opening proof** against the Ethereum mainnet trusted setup embedded at compile time via [kzg-rs](https://github.com/succinctlabs/kzg-rs), confirming the blob bytes match the commitment.
3. It **extracts the declared segment** from the blob's field elements.
4. It **decodes the BAM wire format** into individual message records.
5. It **verifies each EIP-712 ECDSA signature**, dropping any message where recovery fails or the recovered address does not match the declared sender.
6. It **sorts all verified messages** by `(block_number, tx_index, msg_index)` and computes M as the sha256 of their canonical serialization.

The circuit commits `chain_id || M || batch_count || per_batch_metadata` as its public output.

### Circuit 2

Circuit 2 is the app-layer circuit. The first two steps are the shared skeleton that any BAM app's Circuit 2 would run; the rest is bam-twitter-specific.

1. It **recursively verifies the Circuit 1 proof** (a no-op in execute mode, enforced only in prove mode).
2. It **asserts the supplied messages hash to M**, preventing the host from lying about which messages are in scope.
3. It **filters messages by `TWITTER_TAG`**, which is `keccak256("bam-twitter.v1")`.
4. It **decodes the bam-twitter app envelope** from each message's contents.
5. It **deduplicates by `(sender, nonce)`**, with first occurrence winning, following the same rule as bam-store.
6. It **computes R** as the sha256 of the canonical deduplicated timeline.

The circuit commits `chain_id || M || R || tweet_count` as its public output.

### Demo results

The demo ran against 9 Sepolia blobs downloaded from the bam-indexer cache. Circuit 1 produced message commitment M = `0x6cb1ce626cfcb014807ca66751398d97f1477f6d0eacc5d1cfbc987bb29c799c` in roughly 230M SP1 cycles (~25M per blob, dominated by KZG and ECDSA). All 9 messages in that batch were bam-twitter posts, so Circuit 2 produced a timeline of 9 tweets with root R = `0x30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5` in roughly 1.5M cycles — about 150× cheaper than Circuit 1 since it skips KZG and ECDSA entirely.

---

## Running

### Prerequisites

- Rust stable toolchain + [SP1 toolchain](https://docs.succinct.xyz/docs/sp1/getting-started/install)
- A running bam-reader instance with blob archive enabled. The deployed instance at `https://bam-reader.fly.dev` works for the bam-twitter demo on Sepolia. Note that when this was built, the raw blob archive was not yet deployed on bam-reader, so the demo was run against blobs downloaded separately and cached locally. `prove-from-reader` is the intended live path but has not been tested end-to-end against a live blob archive.

### Execute mode (no proof, fast)

Execute mode runs the full circuit logic without generating a STARK proof, letting you verify correctness and check cycle counts. `prove-from-reader` is the standard Circuit 1 path: it fetches batch metadata and raw blob bytes directly from a bam-reader instance. If you have a pre-built blob cache JSON, `prove-reader --cache <file>` skips the network entirely.

```bash
cd apps/bam-coprocessor

# Circuit 1 (fetches blobs from bam-reader blob archive)
cargo run --release --bin prove-from-reader -- \
  --execute --chain-id 11155111 \
  --content-tag 0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718 \
  --reader-url https://bam-reader.fly.dev \
  --output results.json

# Circuit 2 (reads results.json, fetches messages from bam-reader)
cargo run --release --bin prove-app -- \
  --execute \
  --c1-output results.json \
  --reader-url https://bam-reader.fly.dev
```

### Prove mode (Succinct network)

> **Not yet run.** The instructions below are correct and the code is wired up, but prove mode has not been tested against Succinct's prover network. Execute mode works end-to-end; this is the next step.

Before proving for the first time, or after any change to Circuit 1's code, derive the C1 verifying key hash and paste it into `program-app/src/main.rs`. The file currently holds a `[0u32; 8]` placeholder that is safe for execute mode but produces an unsound recursive proof in prove mode.

```bash
cargo run --release --bin print-vk
# prints the [u32; 8] array to paste into program-app/src/main.rs
```

Then prove both circuits on the Succinct network:

```bash
# Circuit 1 (compressed proof, required for C2 recursive verify)
SP1_PROVER=network SP1_PRIVATE_KEY=<key> \
cargo run --release --bin prove-from-reader -- \
  --prove --chain-id 11155111 \
  --content-tag 0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718 \
  --reader-url https://bam-reader.fly.dev \
  --output c1_proof.bin

# Circuit 2 (recursive proof)
SP1_PROVER=network SP1_PRIVATE_KEY=<key> \
cargo run --release --bin prove-app -- \
  --prove \
  --c1-proof c1_proof.bin \
  --reader-url https://bam-reader.fly.dev \
  --output c2_proof.bin

# Inspect and verify the final proof
cargo run --release --bin show-proof -- c2_proof.bin --circuit app --verify
```

Circuit 1 dominates the proving cost since it runs KZG verification and ECDSA; Circuit 2 adds only a recursive verification step on top.

### Building the guest programs

`build.rs` compiles the guest ELFs automatically on `cargo build`. Building the guest crates directly will fail because they target `riscv32im-succinct-zkvm-elf`, not the host architecture.

```bash
cargo build -p bam-coprocessor-script
```

---

## Open issues

1. `start_fe` and `end_fe` are not committed to C1 public outputs, so a verifier can confirm which blob was used but not which segment of it was processed. Fixing this requires a coordinated update to the bam-store schema and C1 output layout.
2. The circuit panics on ZSTD-compressed batches (codec 0x01). None of the current demo blobs use ZSTD, but any production blob that does is outside Circuit 1's scope.
3. The blob archive was not deployed on the bam-reader instance when this was built, so `prove-from-reader` has not been tested end-to-end against a live archive. The demo was run from a locally cached blob set.
4. Prove mode has not been tested on Succinct's prover network — see the note in the prove mode section above.
