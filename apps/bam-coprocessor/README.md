# bam-coprocessor

EIP-4844 blobs expire from Ethereum's consensus layer in roughly 18 days. Without a proof, verifying a BAM message requires trusting the operator who ran the pipeline or replaying computation from raw blob bytes that may no longer exist. This coprocessor removes that dependency. It runs Circuit 1 inside the [SP1](https://docs.succinct.xyz) zkVM and produces a Groth16 proof that a specific BAM message was included in a specific EIP-4844 blob, with the proof tracing cryptographically back to the KZG commitment permanently stored on L1.

The implementation is a demo running against Sepolia blobs.

---

## How it works

Circuit 1 (`program-reader`) proves that a specific BAM message at index `msg_index` was correctly derived from a specific EIP-4844 blob:

1. **Anchors the blob to L1** via `versioned_hash = sha256(kzg_commitment)`.
2. **Verifies the KZG opening proof** against the Ethereum mainnet trusted setup embedded at compile time via [kzg-rs](https://github.com/succinctlabs/kzg-rs), confirming the blob bytes match the commitment on-chain.
3. **Extracts the declared segment** (`start_fe`..`end_fe`) from the blob's field elements.
4. **Decodes the BAM wire format** into individual message records, running the full trailing-bytes check that mirrors bam-reader's rejection behavior.
5. **Asserts the EIP-712 ECDSA signature** for the message at `msg_index`. Invalid signature → proof fails.
6. **Commits the message identity**: `message_hash = keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)` — the ERC-8180 per-message identifier.

### Public output (152 bytes, fixed)

| Offset | Field | Type |
|--------|-------|------|
| 0..8 | chain_id | u64 LE |
| 8..40 | versioned_hash | bytes32 |
| 40..72 | content_tag | bytes32 |
| 72..74 | start_fe | u16 LE |
| 74..76 | end_fe | u16 LE |
| 76..84 | block_number | u64 LE |
| 84..88 | tx_index | u32 LE |
| 88..92 | msg_index | u32 LE |
| 92..112 | sender | address (20 bytes) |
| 112..120 | nonce | u64 LE |
| 120..152 | message_hash | bytes32 |

The proof format is Groth16 (BN254), verifiable by snarkjs in the browser or any standard Groth16 verifier. At ~1.8 KB it is suitable for on-chain verification.

Verification reduces to one keccak256 call on the verifier side: recompute `keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)` and compare to `proof.message_hash`. No other messages from the blob are needed.

---

## Workspace layout

Three crates:

- **`program-reader/`** — Circuit 1 guest, compiled for `riscv32im-succinct-zkvm-elf`.
- **`lib/`** — shared types and pipeline functions (`ReaderBatch`, `BamMessage`, `VerifiedMessage`, `extract_segment_bytes`, `decode_batch`, `verify_ecdsa`, `compute_message_hash`). Compiled for both host and guest.
- **`script/`** — host binaries: `prove-reader`, `prove-from-reader`, `print-vk`, `show-proof`.

`build.rs` compiles the guest ELF automatically on `cargo build`. Do not build guest crates directly — they target the SP1 zkVM, not the host architecture.

---

## Running

### Prerequisites

- Rust stable toolchain + [SP1 toolchain](https://docs.succinct.xyz/docs/sp1/getting-started/install)
- For live blob fetching: bam-reader instance at `https://bam-reader.fly.dev` (Sepolia).

### Execute mode (no proof)

Runs the full circuit logic without generating a STARK proof. Fast — use this to verify correctness and check cycle counts.

```bash
cd apps/bam-coprocessor

# From a pre-built blob cache
cargo run --release --bin prove-reader -- \
  --execute --chain-id 11155111 \
  --cache script/single-new-blob-cache.json \
  --msg-index 0

# From a live bam-reader instance
cargo run --release --bin prove-from-reader -- \
  --execute --chain-id 11155111 \
  --content-tag 0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718 \
  --msg-index 0 \
  --reader-url https://bam-reader.fly.dev
```

### Prove mode (Succinct network)

Requires a [Succinct network](https://explorer.succinct.xyz) account with PROVE tokens. Set `NETWORK_PRIVATE_KEY` to your requester key (secp256k1).

```bash
export NETWORK_PRIVATE_KEY=0x<your_key>

SP1_PROVER=network cargo run --release --bin prove-reader -- \
  --prove --proof-type groth16 --chain-id 11155111 \
  --cache script/single-new-blob-cache.json \
  --msg-index 0 \
  --output c1_proof_groth16.bin
```

Each proof covers one message (~25M SP1 cycles, dominated by KZG opening). At current traffic (≤1 message per app per blob), one proof per blob.

### Inspect a proof

```bash
cargo run --release --bin show-proof -- c1_proof_groth16.bin --circuit reader --verify-groth16
```

### Re-derive the VK hash

Run after any change to `program-reader/src/main.rs`. The `bytes32` output is the value used in `VK_HASH` in `main.ts` and the WASM verifier.

```bash
cargo run --release --bin print-vk
```

---

## Open issues

1. **ZSTD not supported** — the circuit panics on blobs with codec 0x01. None of the current demo blobs use ZSTD, but any production blob that does is out of scope.
2. **`prove-from-reader` untested end-to-end** — live blob archive fetching has not been tested against a running bam-reader instance. The demo was run from locally cached blobs.
