# bam-sp1 — BAM Twitter ZK Coprocessor

SP1 zkVM proof that the bam-twitter indexing pipeline was executed correctly over real Ethereum blob data.

## What it proves

Given blob batches from Sepolia (the private witness), the guest program:
1. Hashes each blob: `sha256(blob_bytes)` — binds the proof to specific byte content
2. Extracts the twitter segment from each blob (`extractSegmentBytes`)
3. Decodes the BAM batch wire format (`decodeBatch`)
4. Filters to `TWITTER_TAG`, decodes tweets (`decodeTwitterContents`)
5. Sorts by canonical chain order, deduplicates by `(sender, nonce)` (`buildTimeline`)
6. Computes timeline root `R = sha256(ordered tweet records)` (`computeTimelineRoot`)

**Public outputs committed to in the proof:**
- `R` — the timeline root (32 bytes)
- `blob_sha256s` — one `sha256(blob_bytes)` per input blob, computed inside the circuit

The off-chain verifier can check: fetch each blob from Blobscan → sha256 → compare against committed hashes → if they match, `R` is tied to real L1 data.

## Structure

```
lib/src/lib.rs          shared pipeline logic (compiled for host + guest)
program/src/main.rs     SP1 guest — runs inside the zkVM, commits public values
script/src/bin/main.rs  host — loads cache, feeds witness, runs execute/prove
```

## Requirements

- Rust (stable)
- SP1 toolchain: `curl -L https://sp1up.succinct.xyz | bash && sp1up`
- `../bam-indexer/cache/batches.json` — run `bam-indexer` first to populate

## Running

```bash
# Fast — no proof, runs the pipeline and checks R matches the TypeScript reference
cargo run --release -- --execute

# Mock proof — tests plumbing without real cryptography (instant)
SP1_PROVER=mock cargo run --release -- --prove

# Real STARK proof — needs ~32GB RAM or a CUDA GPU
cargo run --release -- --prove
```

The `--execute` output should always show:
```
Timeline root R: 0x30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5
✓ R matches TypeScript reference
```

## Cycle count

~89M cycles (dominated by sha256 over 9 × 131KB blobs). The pipeline itself is ~19M cycles.

## Phase roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ | TypeScript reference pipeline (`apps/bam-indexer`) |
| 2 | ✅ | Rust pipeline in SP1, execute mode, R verified against TypeScript |
| 3 | next | Real STARK proof on a GPU machine |
| 4 | future | Replace `sha256(blob_bytes)` with KZG opening via BLS12-381 pairing |

## Key gap (Phase 4)

`blob_sha256s` are derived from bytes the prover fed in, not from the KZG commitments on L1. A dishonest prover could use fake bytes that produce a fraudulent `R`. Phase 4 fixes this by verifying KZG openings inside the circuit, tying the proof directly to the `versioned_hashes` in `BlobBatchRegistered` events on L1.

## BLS12-381 pairing benchmark (`cargo run --release --bin benchmark`)

SP1 v6 has G1 add/double precompiles but **no native pairing precompile**. The Miller loop and Fp12 final exponentiation run in pure software.

| Metric | Cycles |
|--------|--------|
| 1 pairing (software) | ~21.5M |
| 2 pairings = 1 KZG check | ~43M |
| Pipeline baseline (Phase 2, sha256) | 89M |
| Phase 4 estimate (9 blobs × 2 pairings) | ~476M |

**Phase 4 is feasible for batch proving** — 476M cycles is ~5× the Phase 2 cost. On the Succinct prover network this means minutes rather than seconds, acceptable for a proof of the full tweet history.

Optimization: using `multi_miller_loop` + `final_exponentiation` instead of two separate `pairing()` calls shares one final exponentiation between both pairings, saving ~30% (~330M cycles estimated).

## Design docs

See `CryptographyOrg/Projects/Partners/Ethereum Foundation/blobs/`:
- `zk-coprocessor-decisions.md` — architectural decisions, MVP scope
- `zk-coprocessor.md` — full system design
- `toy-example/toy-example.md` — phased build plan
