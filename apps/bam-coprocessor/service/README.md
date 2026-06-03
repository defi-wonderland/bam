# bam-coprocessor-service

A daemon that drives the per-message Circuit 1 guest (see
`apps/bam-coprocessor/REDESIGN.md`) on two cadences against confirmed
bam-forum messages observed by `bam-reader`, persists results in
`coprocessor.*` Postgres tables, and serves the HTTP API the forum
frontend's Vercel proxy consumes.

## Cron jobs

- **Job V — validation** (`*/90 * * * * *`): try-lock both job mutexes;
  ask the reader for confirmed `bam-forum-demo.v1` messages past the
  validation watermark; run C1 in execute mode for each (one `ReaderBatch`
  + `msg_index`); persist a `coprocessor.validations` row + bump the
  watermark per message. Skips the tick when Job P is running.
- **Job P — proof** (`0 0 * * * *`): exclusive `proof_mu`; same candidate
  walk past the proof watermark; produce a Groth16 proof via SP1 for one
  message per tick (default); persist `coprocessor.proofs` + bump
  watermark in one transaction.

## HTTP API

| Route | Purpose |
|---|---|
| `GET /health` | Watermarks, message counts, last-tick timestamps. |
| `GET /validation/latest` | Paginated `MessageValidationEntry` list (newest first). 503 before the first successful V tick. |
| `GET /proof` | Paginated `MessageProofEntry` list (proof bytes elided). |
| `GET /proof/:messageHash` | Full proof bundle: base64 proof + public values + `vkUrl`. |
| `GET /proof/by-blob/:versionedHash` | All proofs covering a given EIP-4844 blob. |
| `GET /proof/vk` | SP1 WASM-verifier VK material (`vkHash`, `groth16VkBytes`, `sp1Version`). 503 before first proof. |

All `bytes32` / `bytes20` / `bytes48` fields are `0x`-prefixed lowercase
hex. `proofBytes` and `publicValues` are base64. `nonce` is a decimal
string (u64 doesn't fit JSON number safely on some clients).

## Environment

```
COPROCESSOR_DB_URL              required  Postgres DSN (rustls TLS).
COPROCESSOR_READER_URL          required  bam-reader base URL.
COPROCESSOR_HTTP_BIND           default 0.0.0.0
COPROCESSOR_HTTP_PORT           default 8790
COPROCESSOR_CHAIN_ID            default 11155111 (Sepolia)
COPROCESSOR_FORUM_TAG           default keccak256("bam-forum-demo.v1")
COPROCESSOR_VALIDATION_CRON     default "*/90 * * * * *"  (every 90 s)
COPROCESSOR_PROOF_CRON          default "0 0 * * * *"     (every hour at :00)
COPROCESSOR_VALIDATION_BATCH_LIMIT  default 50
COPROCESSOR_PROOF_BATCH_LIMIT       default 1
COPROCESSOR_PROVE_BALANCE_THRESHOLD default 0.0 (no pause)
SP1_PROVER                      required at runtime (mock|network|local)
NETWORK_PRIVATE_KEY             required when SP1_PROVER=network
RUST_LOG                        default "info,bam_coprocessor_service=debug"
```

## v1 limitations to address in a follow-up

- **No `proof_in_flight` recovery.** Job P uses the blocking
  `sp1_runner::prove_c1` wrapper, which only returns after Succinct
  finalises the proof. A process restart mid-prove forfeits visibility
  into the in-flight request and pays the fee again on the next tick.
  The DDL provisions the table; `jobs::recovery` is a no-op until Job P
  switches to `sp1_sdk::network::NetworkClient` and captures
  `request_id` synchronously.
- **No Succinct balance check.** `prove_balance_threshold` is read from
  the environment but not consulted. Lands with the NetworkClient
  migration.
- **Linear chain-coord cursor.** Candidate selection fetches up to 1000
  confirmed messages from the reader and filters past the watermark
  client-side; a high-traffic forum past 1000 rows between ticks would
  under-cover. Bam-reader does not yet expose a chain-coord cursor.

## Local dev

```
pnpm db:up    # docker-compose Postgres on 127.0.0.1:5432

cd apps/bam-coprocessor/service
SP1_PROVER=mock \
COPROCESSOR_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/bam \
COPROCESSOR_READER_URL=https://bam-reader.fly.dev \
cargo run --release
```

In mock mode `prove_c1` returns a non-cryptographic proof, exercising
the full pipeline without spending PROVE tokens.
