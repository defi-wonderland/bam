# bam-coprocessor

EIP-4844 blobs expire from Ethereum's consensus layer in roughly 18 days. Without a proof, verifying a BAM message requires trusting the operator who ran the pipeline or replaying computation from raw blob bytes that may no longer exist. This coprocessor removes that dependency. It runs Circuit 1 inside the [SP1](https://docs.succinct.xyz) zkVM and produces a Groth16 proof that a specific BAM message was included in a specific EIP-4844 blob, with the proof tracing cryptographically back to the KZG commitment permanently stored on L1.

The implementation runs against Sepolia blobs.

---

## How it works

Circuit 1 (`program-reader`) proves that a specific BAM message at index `msg_index` was correctly derived from a specific EIP-4844 blob. The circuit runs six steps inside the SP1 zkVM:

1. **Scope assertion** — rejects blobs that use an on-chain decoder or sig registry (`decoder == 0x0`, `sig_registry == 0x0`). Those are outside the circuit's current scope.
2. **L1 anchor** — asserts `versioned_hash[0] == 0x01` and `versioned_hash[1..] == sha256(commitment)[1..]`. This ties the blob bytes to the KZG commitment stored permanently on L1.
3. **KZG opening verification** — verifies the blob against the Ethereum mainnet trusted setup embedded at compile time via [kzg-rs](https://github.com/succinctlabs/kzg-rs). Uses SP1 precompiles; costs ~25M cycles, dominated by BLS12-381 operations.
4. **Segment extraction** — reads field elements `[start_fe, end_fe)` from the blob, strips the leading 0x00 padding byte from each 32-byte FE, and concatenates the 31 usable bytes per FE into a flat byte slice.
5. **BAM wire decode** — decodes the full segment (header: version/codec/count/len, then per-message records with 65-byte signatures). Runs the trailing-bytes check that mirrors bam-reader's rejection behavior — a message from a malformed batch is not provable even if the target message is valid. Panics loudly on ZSTD codec (0x01).
6. **ECDSA + message hash** — asserts the EIP-712 secp256k1 signature for the message at `msg_index` (panics on failure; the host should pre-validate before submitting to the network). Computes `message_hash = keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)` — the ERC-8180 per-message identifier.

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

The layout is fixed-size and contains everything needed to locate the message on-chain without auxiliary data. `start_fe` and `end_fe` are public outputs, so the verifier can cross-check them against the `BlobSegmentDeclared` L1 event.

The proof format is Groth16 (BN254). At ~1.8 KB it is suitable for on-chain verification and can be verified in the browser via snarkjs or the SP1 WASM verifier.

Verification on the consumer side reduces to one keccak256 call: recompute `keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)` and compare to `proof.message_hash`. No other messages from the blob are required.

---

## Workspace layout

```
apps/bam-coprocessor/
├── lib/                    # shared types and pipeline functions
│   └── src/lib.rs
├── program-reader/         # Circuit 1 guest (riscv32im-succinct-zkvm-elf)
│   └── src/main.rs
└── script/                 # host binaries and tests
    ├── src/
    │   ├── lib.rs          # MessagePublicValues, parse/print helpers
    │   └── bin/
    │       ├── prove-reader.rs       # prove from static blob cache
    │       ├── prove-from-reader.rs  # prove from live bam-reader API
    │       ├── show-proof.rs         # inspect and verify saved proofs
    │       └── print-vk.rs          # derive Circuit 1 VK hash
    ├── tests/
    │   └── circuit_e2e.rs  # end-to-end integration test (synthetic blob)
    └── build.rs            # compiles program-reader ELF automatically
```

**`lib/`** compiles for both the host (x86_64) and the guest (riscv32im). Key exports:

- `BlobInput` — all Circuit 1 private inputs for one blob batch.
- `BamMessage` / `VerifiedMessage` — decoded message types.
- `extract_segment_bytes(blob, start_fe, end_fe)` — strips FE padding, returns flat byte slice.
- `decode_bam_payload(segment)` — full BAM wire decode, returns `(messages, sigs)`.
- `verify_ecdsa(sender, content_tag, nonce, contents, sig, chain_id)` — EIP-712 secp256k1 verify, rejects high-s.
- `compute_message_hash(sender, content_tag, nonce, contents)` — `keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents)`.

`build.rs` compiles the guest ELF automatically on `cargo build`. Do not build guest crates directly — they target the SP1 zkVM, not the host architecture.

---

## Running

### Prerequisites

- Rust stable + the [SP1 toolchain](https://docs.succinct.xyz/docs/sp1/getting-started/install) (`rustup toolchain install` per `rust-toolchain`).
- For live blob fetching (`prove-from-reader`): a bam-reader instance — the Sepolia deployment is at `https://bam-reader.fly.dev`.
- For network proving: a [Succinct network](https://explorer.succinct.xyz) account with PROVE tokens.

### Execute mode (no proof)

Runs the full circuit logic without generating a proof. Fast — use this to verify correctness, check cycle counts, and cross-check `message_hash` against bam-indexer.

```bash
cd apps/bam-coprocessor

# From a static blob cache (JSON array of batch objects)
cargo run --release --bin prove-reader -- \
  --execute --chain-id 11155111 \
  --cache path/to/batches.json \
  --msg-index 0

# From a live bam-reader instance (fetches blob via /blobs/:versionedHash,
# falls back to beacon chain if that returns non-200)
cargo run --release --bin prove-from-reader -- \
  --execute --chain-id 11155111 \
  --reader-url https://bam-reader.fly.dev \
  --content-tag 0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718 \
  --msg-index 0
```

Both scripts accept `--output <path>.json` to save the execute result (public values + cycle count) as JSON.

### Prove mode (Succinct network)

```bash
export NETWORK_PRIVATE_KEY=0x<your_requester_key>

SP1_PROVER=network cargo run --release --bin prove-reader -- \
  --prove --proof-type groth16 --chain-id 11155111 \
  --cache path/to/batches.json \
  --msg-index 0 \
  --output c1_proof_groth16.bin
```

The `.bin` file is bincode-serialised (Rust-internal). To get a browser-usable artifact, pass it through `show-proof --dump-components` (see below).

### Inspecting a proof

```bash
# Pretty-print the 152-byte public output
cargo run --release --bin show-proof -- c1_proof_groth16.bin

# Cryptographic verification (runs BN254 pairing check — same as browser verifier)
cargo run --release --bin show-proof -- c1_proof_groth16.bin --verify-groth16

# Dump a browser-ready JSON artifact
# Outputs: { proof (hex), public_inputs (hex), vk_hash (bytes32) }
cargo run --release --bin show-proof -- c1_proof_groth16.bin --dump-components --output proof.json
```

The `--dump-components` JSON is what the demo frontend consumes. `vk_hash` is auto-derived from `public_inputs[0]` (gnark encoding → bytes32) — no manual copy-paste needed.

### Re-deriving the VK hash

Run this after any change to `program-reader/src/main.rs`. The circuit changes → the ELF changes → the VK hash changes. The `bytes32` value is what the demo's `VK_HASH` constant and the WASM verifier use.

```bash
cargo run --release --bin print-vk
```

Current VK hash (block 10932896 proof): `0x00fd3e975e4b34ca3b11039c667bac65139250feb733ff576c9e9f09e6875840`

### End-to-end integration test

Builds a synthetic blob from scratch (generates a test key, encodes a BAM batch, packs it into a full 131072-byte blob, generates a real KZG proof via c-kzg), runs the circuit in execute mode, and cross-checks `message_hash` against the lib-computed value. Runs on the host, no SP1 toolchain or network access needed.

```bash
cargo test --release -p bam-coprocessor-script
```

---

## blob cache format

`prove-reader` reads a JSON array. Each entry:

```json
{
  "versioned_hash": "0x01...",
  "block_number": 10932896,
  "tx_index": 248,
  "startFE": 0,
  "endFE": 4096,
  "blob_bytes_hex": "0x...",
  "content_tag": "0x...",   // optional, defaults to 0x0
  "decoder": "0x...",       // optional, defaults to 0x0
  "sig_registry": "0x..."   // optional, defaults to 0x0
}
```

`prove-from-reader` fetches the blob live and does not require `blob_bytes_hex`, but `start_fe`/`end_fe` are currently hardcoded to `[0, 4096)` because bam-reader's `/batches` API does not expose them. This is a known gap — see Open Issues.

---

## Blob fetching in prove-from-reader

1. **Primary**: `GET /blobs/:versionedHash` on the bam-reader instance. Returns 131072 raw bytes. Note: HEAD requests always return 404 on the Fly deployment; use GET.
2. **Fallback (Sepolia only)**: Lodestar Sepolia beacon API. Estimates the beacon slot from the execution block number via linear interpolation, then searches ±50 slots for matching blob sidecars (matched by versioned hash derived from the KZG commitment in the sidecar). This fallback is Sepolia-specific; Blobscan does not index BAM blobs.

---

## Key invariants

**Full segment decode required.** `decode_bam_payload` must run on the full `[start_fe, end_fe)` segment even when proving a single `msg_index`. The trailing-bytes check mirrors bam-reader's rejection behavior — a message from a malformed batch is not provable.

**ECDSA: assert, not filter.** An invalid signature at `msg_index` causes the proof to fail. The host (`prove-reader`, `prove-from-reader`) should pre-validate ECDSA before submitting to the Succinct network to avoid burning proving fees.

**nonce is big-endian in message_hash.** `keccak256(sender ‖ content_tag ‖ nonce.to_be_bytes() ‖ contents)` — same encoding as the EIP-712 struct hash. A mismatch (e.g. LE instead of BE) produces a silently wrong `message_hash` with no circuit error.

**VK hash format.** SP1 exposes two representations: `hash_u32` (eight u32s, for `verify_sp1_proof` in recursive guests) and `bytes32` (for Groth16Verifier and the WASM browser verifier). `print-vk` prints both. Use `bytes32` for the demo.

---

## Open issues

**ZSTD codec not supported** (high severity — proof completeness). The circuit panics on blobs with `codec == 0x01`. bam-reader fully supports ZSTD; any production blob that uses it is currently unprovable. Fix: add `ruzstd` (pure-Rust, `no_std`-compatible) decompression to `lib/`. The Sepolia demo blobs all use `codec == 0x00` (no compression).

**`start_fe`/`end_fe` not exposed by bam-reader** (medium severity — correctness). `prove-from-reader` defaults both to `[0, 4096)` because `BatchRow` in bam-store does not store them and `/batches` does not return them. For blobs where the BAM segment does not cover the full blob, this produces incorrect segment extraction. Fix requires a coordinated schema change in bam-store + bam-reader, then plumbing through `prove-from-reader`. The current Sepolia demo blobs all use single-segment full-blob packing, so this does not affect them in practice.
