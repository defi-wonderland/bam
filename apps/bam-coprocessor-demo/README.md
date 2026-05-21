# bam-coprocessor-demo

Static demo website for the BAM ZK coprocessor. Shows the proof generation story (hardcoded — real proving takes 30s and costs PROVE tokens) and lets the user **fetch and verify the Groth16 proof locally** using an SP1 WASM verifier. No backend, no wallet, no trust in the demo server.

The demo is built around one real proof: the "Hello world" bam-twitter post from Sepolia block 10767913, proved on Succinct's mainnet prover network on 2026-05-20.

---

## Status

The app is **fully built and working**. `pnpm dev` and `pnpm build` both work. The only thing missing before the VERIFY button works end-to-end is building the WASM verifier (one-time step, ~2 min).

---

## Architecture

```
apps/bam-coprocessor-demo/
  index.html              ← single page, all UI
  src/
    main.ts               ← fetch proof.json → load WASM → verify_groth16 → update UI
    style.css             ← Tailwind + bam-twitter palette
  public/
    proof.json            ← Groth16 proof components (committed — generated from c1_proof_groth16.bin)
    verifier/             ← wasm-pack output (gitignored — build step below)
      sp1_wasm_verifier.js
      sp1_wasm_verifier_bg.wasm
  vite.config.ts          ← externalizes /verifier/* so Rollup doesn't bundle it
  package.json
  vercel.json
```

**Verification flow:**
1. User clicks VERIFY
2. Browser fetches `public/proof.json` (1.1 KB)
3. Dynamically imports `/verifier/sp1_wasm_verifier.js` (static file from `public/`)
4. Calls `verify_groth16(proofBytes, publicInputsBytes, VK_HASH)` — runs in browser
5. Shows result with timing — no server call for the verification step

---

## Tech stack

Follows the `bam-blog-demo` pattern: **Vite + TypeScript**, no framework. Tailwind for styling (same `bird-*` palette as bam-twitter). No wallet, no wagmi, no RainbowKit.

---

## Setup

### 1. Install JS dependencies

```bash
cd apps/bam-coprocessor-demo
pnpm install
```

### 2. WASM verifier (already committed)

The compiled WASM verifier is committed to `public/verifier/` — no build step needed. It was built from `verifier-wasm/` (a thin `wasm-bindgen` wrapper around `sp1-verifier = "=6.1.0"`):

```
public/verifier/
  sp1_wasm_verifier.js       — JS bindings
  sp1_wasm_verifier_bg.wasm  — the verifier (~5 MB)
  sp1_wasm_verifier.d.ts     — TypeScript types
```

If you need to rebuild it (e.g. after an sp1-verifier version bump):

```bash
cd apps/bam-coprocessor-demo/verifier-wasm
wasm-pack build --target web --release
cp -r pkg/ ../public/verifier/
```

### 3. Run

```bash
pnpm dev     # dev server at http://localhost:5173
pnpm build   # production build to dist/
```

---

## Hardcoded proof data

Everything on the page is derived from one real proof, available at the Succinct explorer.

**The tweet:**

| Field | Value |
|---|---|
| Content | `Hello world` |
| Sender | `0x2f47568fbb8c1fdf0e904fab02004a9560e4cd5f` |
| Block | 10767913 (Sepolia) |
| Tx index | 146 |
| Blob tx | `0x01450506121d21480f0786b669c5baef9b594bb6a8da0000415568bdf04dbc95` |
| Versioned hash | `0x01e88c3f78543596ba21c5def18454d0f5dc8c921c8d12b80059a4522ffd76819` |

**The proof:**

| Field | Value |
|---|---|
| M (message commitment) | `0x30774dd5d445ee8549abf847572ece0c0b7f594ca1da16dffae4694a519b16c8` |
| Program hash (VK) | `0x009719dd1c4447c79d11830b020ce5c1edf7f3b3019031e26dbe89a4ef5f6c9c` |
| Proof mode | Groth16 |
| Proof size | 1.8 KB |
| SP1 version | sp1-v6.1.0 |
| Proved on | 2026-05-20 |
| Proving time | 30s |
| Cost | 0.313 PROVE |
| Request ID | `0x186d4e805a09260414bbd4dfe0ce91d142b74cef24be4cb96b7e05b48a71dd2d` |
| Succinct explorer | https://explorer.succinct.xyz/request/0x186d4e... |

---

## How `proof.json` was generated

`proof.json` (in `public/`) was generated from `apps/bam-coprocessor/c1_proof_groth16.bin` using a flag added to the `show-proof` binary:

```bash
cd apps/bam-coprocessor
cargo run --release --bin show-proof -- c1_proof_groth16.bin \
  --dump-components 2>/dev/null \
  > ../bam-coprocessor-demo/public/proof.json
```

`--dump-components` extracts the proof bytes that `sp1-verifier` expects (`proof.bytes()` = `groth16_vkey_hash[0:4] || encoded_proof`, 356 bytes total) and `SP1ProofWithPublicValues.public_values` into a JSON object. The `vk_hash` field is auto-derived from `g16.public_inputs[0]` (the BN254 Fr scalar stored by the gnark circuit) — no hardcoded value:

```json
{
  "proof": "<hex of proof.bytes() — 356 bytes starting with 4388a21c>",
  "public_inputs": "<hex of public values bytes>",
  "vk_hash": "0x009719dd1c4447c79d11830b020ce5c1edf7f3b3019031e26dbe89a4ef5f6c9c"
}
```

If `c1_proof_groth16.bin` ever needs to be re-proved, re-run the command above to update `proof.json`. The `vk_hash` will update automatically from the new proof's public inputs.

---

## What `verify_groth16` checks

The WASM verifier (`sp1-verifier` crate compiled to WASM) checks:

1. The 4-byte Groth16 VK prefix in the proof matches the expected `groth16_vk` embedded in `sp1-verifier`
2. The exit code and VK root are valid
3. The Gnark Groth16 proof verifies algebraically against the public inputs (which include a hash of the SP1 public outputs and the program VK hash)

`vk_hash` (`0x009719dd…`) is the SP1 program VK hash (`vk.bytes32()`) — identifies the exact Circuit 1 guest binary. If the circuit code changes, this hash changes and old proofs won't verify against a new VK.

The verification does **not** check L1 anchoring (that `versioned_hash` exists on Ethereum). That's a separate RPC call; the page links to Etherscan for manual inspection.

---

## Deployment

Follows the `bam-blog-demo` Vercel pattern:

```json
{
  "installCommand": "cd ../.. && pnpm install",
  "buildCommand": "cd ../.. && pnpm --filter bam-coprocessor-demo build"
}
```

Note: the `public/verifier/` directory must be present at build time for the WASM to be served. Add a pre-build step or commit the WASM artifacts (they are gitignored by default since the `.wasm` file is ~5–10 MB).
