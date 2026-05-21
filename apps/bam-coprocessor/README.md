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

## Proof formats

Circuit 1 supports two output formats, selected with `--proof-type`:

**`compressed` (default)** — a STARK proof. This is the format Circuit 2 requires to run its recursive verification step (`verify_sp1_proof` inside the SP1 guest). Use this when the proof will be consumed by another SP1 program.

**`groth16`** — a succinct BN254 Groth16 proof (~200 bytes). This is the format for final output: it can be verified by [snarkjs](https://github.com/iden3/snarkjs) in the browser, a Solidity contract, or any standard Groth16 verifier. It cannot be consumed by Circuit 2's recursive verify step.

The two formats are **not interchangeable**: Circuit 2 consumes a compressed STARK; a browser or on-chain verifier consumes Groth16.

In the full two-circuit flow, the proof you ship to end users is Circuit 2's Groth16 proof — it already embeds the recursive C1 verification, so you get the full chain of trust in a single small proof. If Circuit 1 is used standalone (no Circuit 2), generate a Groth16 directly from `prove-reader --proof-type groth16`.

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

**Execute mode** ran against 9 Sepolia blobs from the bam-indexer cache. Circuit 1 produced message commitment M = `0x6cb1ce626cfcb014807ca66751398d97f1477f6d0eacc5d1cfbc987bb29c799c` in roughly 230M SP1 cycles (~25M per blob, dominated by KZG and ECDSA). All 9 messages in that batch were bam-twitter posts, so Circuit 2 produced a timeline of 9 tweets with root R = `0x30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5` in roughly 1.5M cycles — about 150× cheaper than Circuit 1 since it skips KZG and ECDSA entirely.

Both proofs below ran against the same single blob — block 10767913, tx 146, the `Hello world` bam-twitter post from the EXPLAINER. Same program, same input, different output format.

| Field | Compressed | Groth16 |
|---|---|---|
| Proof mode | Compressed STARK | Groth16 (BN254) |
| Proof size | 1.2 MB | **1.8 KB** |
| Proving time | 20s | 30s |
| Base fee | 0.2 PROVE | 0.3 PROVE |
| Prover fee | 0.013 PROVE | 0.013 PROVE |
| Total fee | 0.213 PROVE | 0.313 PROVE |
| Gas used | 25,839,061 PGUs | 25,839,061 PGUs |
| Price | 0.49 PROVE / bPGU | 0.49 PROVE / bPGU |

The Groth16 proof is **680× smaller** at the cost of +0.1 PROVE base fee and +10s proving time. The prover fee is identical since the underlying computation (PGUs) is the same. Groth16's higher base fee reflects the additional wrapping step on the network's side.

**Use compressed** when the proof will be recursively verified by Circuit 2. **Use Groth16** when the proof is the final output — it can be verified by snarkjs in the browser, a Solidity contract, or any standard BN254 Groth16 verifier.

**Compressed proof** (2026-05-20):

| Field | Value |
|---|---|
| M (message commitment) | `0x30774dd5d445ee8549abf847572ece0c0b7f594ca1da16dffae4694a519b16c8` |
| SP1 version | sp1-v6.1.0 |
| Cycles | 25,632,786 |
| Request ID | `0xaa2caee39af75e6d124cb87c23983b484a29c90a26da8a1e37fedcecd9dddc36` |
| Program hash | `0x4b8cee8e1111f1e72230616020ce5c1e6fbf9d980640c7895b7d13496f5f6c9c` |
| Tx hash | `0x03f41203e8c4a3f128942cbecb15b5bf34a2062bbe02c9a48fc48591cea6cb88` |

**Groth16 proof** (2026-05-20):

| Field | Value |
|---|---|
| M (message commitment) | `0x30774dd5d445ee8549abf847572ece0c0b7f594ca1da16dffae4694a519b16c8` |
| SP1 version | sp1-v6.1.0 |
| Cycles | 25,632,786 |
| Request ID | `0x186d4e805a09260414bbd4dfe0ce91d142b74cef24be4cb96b7e05b48a71dd2d` |
| Program hash | `0x4b8cee8e1111f1e72230616020ce5c1e6fbf9d980640c7895b7d13496f5f6c9c` |
| Tx hash | `0xe5e2a321a66c3f0070cdc675d43147b5bfabd16c3e79b58217569f8bc9daf7a2` |

Note: the SDK automatically sets the gas limit from a simulation run before submitting — the gas limit shown equals the measured PGU count exactly.

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

Requires a [Succinct network](https://explorer.succinct.xyz) account with PROVE tokens deposited. Set `NETWORK_PRIVATE_KEY` to your requester account's private key (secp256k1, same format as an Ethereum key). The old `SP1_PRIVATE_KEY` variable name is not read by sp1-sdk v6.x.

The `script/Cargo.toml` dependency must include the `network` feature:

```toml
sp1-sdk = { version = "6.0.1", features = ["blocking", "network"] }
```

**Circuit 1** — from a local blob cache (tested path):

```bash
export NETWORK_PRIVATE_KEY=0x<your_key>

# Compressed STARK — for Circuit 2 recursive consumption (default)
SP1_PROVER=network cargo run --release --bin prove-reader -- \
  --prove --chain-id 11155111 \
  --cache script/single-blob-cache.json \
  --output c1_proof.bin

# Groth16 — for client-side / browser / on-chain verification (standalone C1)
SP1_PROVER=network cargo run --release --bin prove-reader -- \
  --prove --proof-type groth16 --chain-id 11155111 \
  --cache script/single-blob-cache.json \
  --output c1_proof_groth16.bin
```

`script/single-blob-cache.json` contains the single Sepolia blob from the first network proof. Swap in the full `../bam-indexer/cache/batches.json` for all 9 blobs (~230M cycles, ~9× the cost).

`prove-from-reader` is the intended live path (fetches blobs directly from a bam-reader instance) but has not been tested end-to-end against a live blob archive.

**Verify Circuit 1:**

```bash
cargo run --release --bin show-proof -- c1_proof.bin --circuit reader --verify
```

**Before proving Circuit 2**, derive the C1 verifying key and paste it into `program-app/src/main.rs`. The file currently holds a `[0u32; 8]` placeholder that is safe for execute mode but produces an unsound recursive proof in prove mode.

```bash
cargo run --release --bin print-vk
# paste the printed [u32; 8] array into program-app/src/main.rs
```

**Circuit 2** — recursive proof:

```bash
export NETWORK_PRIVATE_KEY=0x<your_key>
SP1_PROVER=network cargo run --release --bin prove-app -- \
  --prove \
  --c1-proof c1_proof.bin \
  --reader-url https://bam-reader.fly.dev \
  --output c2_proof.bin

cargo run --release --bin show-proof -- c2_proof.bin --circuit app --verify
```

Circuit 1 dominates cost (KZG + ECDSA). Circuit 2 adds only the recursive verification step — execute mode measured ~1.5M cycles vs ~25M for C1.

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
4. Circuit 2 has not yet been proved on the network. The C1 verifying key placeholder `[0u32; 8]` in `program-app/src/main.rs` must be replaced with the output of `print-vk` before prove mode produces a sound recursive proof.
