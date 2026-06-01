import './style.css';

const VK_HASH = '0x00fd3e975e4b34ca3b11039c667bac65139250feb733ff576c9e9f09e6875840';
const BAM_INDEXER = 'https://bam-indexer.fly.dev';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProofEntry {
  block_number: number;
  tx_index: number;
  file: string;
  network: string;
  chain_id: number;
}

interface Post {
  sender: string;
  nonce: string;
  content: string;
  kind: string;
  timestamp: number | string;
  block_number: number;
  tx_index: number;
  message_index_within_batch: number;
  parent_message_hash: string | null;
}

interface Batch {
  block_number: number;
  tx_index: number;
  posts: Post[];
  proof: ProofEntry | null;
}

interface VerifierModule {
  default: (wasmUrl?: string) => Promise<void>;
  verify_groth16: (proof: Uint8Array, public_inputs: Uint8Array, vk_hash: string) => string;
}

interface ProofJson {
  proof: string;
  public_inputs: string;
  vk_hash: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function abbrev(addr: string, front = 6, back = 4): string {
  return addr.slice(0, front) + '…' + addr.slice(-back);
}

function abbrevHash(hex: string): string {
  return hex.slice(0, 10) + '…' + hex.slice(-6);
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, true);
}

function networkName(chainId: bigint): string {
  if (chainId === 1n) return 'Mainnet';
  if (chainId === 11155111n) return 'Sepolia';
  return `chain ${chainId}`;
}

// Decode the committed public outputs from program-reader.
// Layout: chain_id(8 LE) | M(32) | batch_count(4 LE) |
//   per batch: versioned_hash(32) | commitment(48) | content_tag(32) | block_number(8 LE) | tx_index(4 LE)
function decodePublicInputs(pi: Uint8Array) {
  const chainId = readU64LE(pi, 0);
  const m = toHex(pi.slice(8, 40));
  const batchCount = readU32LE(pi, 40);
  const batchOffset = 44;
  const batchStride = 124;
  // Per-batch layout: versioned_hash(32) | commitment(48) | content_tag(32) | block_number(8 LE) | tx_index(4 LE)
  const batches = Array.from({ length: batchCount }, (_, i) => {
    const base = batchOffset + i * batchStride;
    return {
      versionedHash: toHex(pi.slice(base, base + 32)),
      blockNumber: readU64LE(pi, base + 112),
      txIndex: readU32LE(pi, base + 120),
    };
  });
  return { chainId, m, batchCount, batches };
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
}

// Re-encode the bam-twitter app payload from decoded fields.
// Mirrors decode_twitter_contents in lib/src/lib.rs (post-PR#59 layout, no contentTag prefix).
// Post:  version(1=0x01) | kind(0x00) | timestamp(8 BE) | content_len(4 BE) | content_utf8
// Reply: version(1=0x01) | kind(0x01) | timestamp(8 BE) | parent_hash(32)   | content_len(4 BE) | content_utf8
function encodeContents(post: Post): Uint8Array {
  const contentBytes = new TextEncoder().encode(post.content);
  const ts = BigInt(typeof post.timestamp === 'number' ? post.timestamp : parseInt(String(post.timestamp)));

  if (post.kind === 'reply' && post.parent_message_hash) {
    const parentHash = fromHex(post.parent_message_hash);
    const buf = new Uint8Array(1 + 1 + 8 + 32 + 4 + contentBytes.length);
    const v = new DataView(buf.buffer);
    buf[0] = 0x01; buf[1] = 0x01;
    v.setBigUint64(2, ts, false);
    buf.set(parentHash, 10);
    v.setUint32(42, contentBytes.length, false);
    buf.set(contentBytes, 46);
    return buf;
  }

  const buf = new Uint8Array(1 + 1 + 8 + 4 + contentBytes.length);
  const v = new DataView(buf.buffer);
  buf[0] = 0x01; buf[1] = 0x00;
  v.setBigUint64(2, ts, false);
  v.setUint32(10, contentBytes.length, false);
  buf.set(contentBytes, 14);
  return buf;
}

// Recompute M using the same algorithm as compute_message_commitment in lib/src/lib.rs.
// Single rolling SHA-256 over all messages serialized as:
//   record_len(4 BE) | sender(20) | nonce(8 BE) | contents_len(4 BE) | contents(N) | block_number(8 BE) | tx_index(4 BE) | msg_index(4 BE)
async function computeM(posts: Post[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for (const post of posts) {
    const sender = fromHex(post.sender);
    const nonce = BigInt(post.nonce);
    const contents = encodeContents(post);
    const recordLen = 20 + 8 + 4 + contents.length + 8 + 4 + 4;

    const record = new Uint8Array(4 + recordLen);
    const v = new DataView(record.buffer);
    v.setUint32(0, recordLen, false);                                            // record_len  4 BE
    record.set(sender, 4);                                                       // sender      20
    v.setBigUint64(24, nonce, false);                                            // nonce       8 BE
    v.setUint32(32, contents.length, false);                                     // contents_len 4 BE
    record.set(contents, 36);                                                    // contents    N
    v.setBigUint64(36 + contents.length, BigInt(post.block_number), false);      // block_number 8 BE
    v.setUint32(44 + contents.length, post.tx_index, false);                     // tx_index    4 BE
    v.setUint32(48 + contents.length, post.message_index_within_batch, false);   // msg_index   4 BE
    chunks.push(record);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return sha256(all);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(ts: number | string): string {
  try {
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return String(ts);
  }
}

function spinnerHtml(msg: string): string {
  return `
    <div class="flex items-center gap-2 text-sm text-slate-500">
      <svg class="animate-spin h-4 w-4 text-bird-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
      </svg>
      ${msg}
    </div>`;
}

function failCard(title: string, body: string): string {
  return `
    <div class="rounded-lg bg-red-50 border border-red-200 p-4">
      <div class="flex items-center gap-2 text-red-700 font-medium text-sm mb-2">
        <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
        ${title}
      </div>
      ${body}
    </div>`;
}

// ── WASM verifier — lazy singleton ────────────────────────────────────────────

let _verifierPromise: Promise<VerifierModule> | null = null;

function getVerifier(): Promise<VerifierModule> {
  if (!_verifierPromise) {
    _verifierPromise = (async () => {
      // new Function escapes Vite's static import analyzer
      const mod: VerifierModule = await (new Function('s', 'return import(s)'))('/verifier/sp1_wasm_verifier.js');
      await mod.default('/verifier/sp1_wasm_verifier_bg.wasm');
      return mod;
    })();
  }
  return _verifierPromise;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadIndex(): Promise<ProofEntry[]> {
  const res = await fetch('/proofs/index.json');
  if (!res.ok) throw new Error(`/proofs/index.json: HTTP ${res.status}`);
  return res.json();
}

async function loadPosts(): Promise<Post[]> {
  const res = await fetch(`${BAM_INDEXER}/twitter/posts?limit=200`);
  if (!res.ok) throw new Error(`bam-indexer: HTTP ${res.status}`);
  const data = await res.json() as { posts: Post[] };
  return data.posts ?? [];
}

function groupIntoBatches(posts: Post[], index: ProofEntry[]): Batch[] {
  const proofMap = new Map<string, ProofEntry>();
  for (const p of index) proofMap.set(`${p.block_number}_${p.tx_index}`, p);

  const batchMap = new Map<string, Batch>();
  for (const post of posts) {
    const key = `${post.block_number}_${post.tx_index}`;
    if (!batchMap.has(key)) {
      batchMap.set(key, {
        block_number: post.block_number,
        tx_index: post.tx_index,
        posts: [],
        proof: proofMap.get(key) ?? null,
      });
    }
    batchMap.get(key)!.posts.push(post);
  }

  for (const batch of batchMap.values()) {
    batch.posts.sort((a, b) => a.message_index_within_batch - b.message_index_within_batch);
  }

  return [...batchMap.values()].sort(
    (a, b) => b.block_number - a.block_number || b.tx_index - a.tx_index,
  );
}

// ── Verify ────────────────────────────────────────────────────────────────────

async function doVerify(proof: ProofEntry, batch: Batch, btn: HTMLButtonElement, result: HTMLElement) {
  btn.disabled = true;
  btn.textContent = 'Loading…';
  result.classList.remove('hidden');

  // Step 1: fetch proof file
  result.innerHTML = spinnerHtml('Fetching proof…');
  let proofJson: ProofJson;
  try {
    const res = await fetch(`/proofs/${proof.file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    proofJson = await res.json() as ProofJson;
  } catch (e) {
    result.innerHTML = failCard('Failed to fetch proof', `<p class="text-xs text-red-600">${escHtml(String(e))}</p>`);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }

  // Step 2: load WASM verifier
  result.innerHTML = spinnerHtml('Loading WASM verifier…');
  let verifier: VerifierModule;
  try {
    verifier = await getVerifier();
  } catch (e) {
    result.innerHTML = failCard('WASM verifier failed to load', `<p class="text-xs text-red-600">${escHtml(String(e))}</p>`);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }

  // Step 3: Groth16 proof verification
  result.innerHTML = spinnerHtml('Verifying Groth16 proof…');
  const t0 = performance.now();
  const proofBytes = fromHex(proofJson.proof);
  const piBytes = fromHex(proofJson.public_inputs);
  let groth16Err: string;
  try {
    groth16Err = verifier.verify_groth16(proofBytes, piBytes, VK_HASH);
  } catch (e) {
    groth16Err = String(e);
  }

  if (groth16Err !== '') {
    result.innerHTML = failCard('Groth16 verification failed', `<p class="text-xs text-red-600 font-mono break-all">${escHtml(groth16Err)}</p>`);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }

  // Step 4: recompute M from the displayed messages and assert it matches the proof
  result.innerHTML = spinnerHtml('Checking message commitment…');
  const pi = decodePublicInputs(piBytes);
  let computedM: Uint8Array;
  try {
    computedM = await computeM(batch.posts);
  } catch (e) {
    result.innerHTML = failCard('Could not recompute M', `<p class="text-xs text-red-600">${escHtml(String(e))}</p>`);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }

  const proofM = fromHex(pi.m);
  const mMatches = computedM.length === proofM.length && computedM.every((b, i) => b === proofM[i]);

  if (!mMatches) {
    result.innerHTML = failCard('Message commitment mismatch', `
      <div class="space-y-1.5 text-xs text-slate-700">
        <p>M in proof:   <span class="font-mono">${abbrevHash(pi.m)}</span></p>
        <p>M recomputed: <span class="font-mono">${abbrevHash(toHex(computedM))}</span></p>
        <p class="text-slate-500 mt-1">The messages shown do not match what was proven. The proof is valid but covers different content.</p>
      </div>`);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }

  // Both checks passed
  const ms = Math.round(performance.now() - t0);
  const network = networkName(pi.chainId);
  const b = pi.batches[0];
  const sigLines = batch.posts.map(p =>
    `<li><span class="font-mono">${abbrev(p.sender)}</span> signed <span class="italic">"${escHtml(p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content)}"</span></li>`
  ).join('');

  result.innerHTML = `
    <div class="rounded-lg bg-emerald-50 border border-emerald-200 p-4 space-y-3">
      <div class="flex items-center gap-2 text-emerald-700 font-semibold text-sm">
        <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
        Proof verified in ${ms}ms
      </div>

      <div class="space-y-2.5 text-xs text-slate-700">

        <div>
          <p class="font-medium text-slate-500 uppercase tracking-wide mb-0.5">KZG opening</p>
          <p>Blob <span class="font-mono">${abbrevHash(b.versionedHash)}</span> was committed to ${network} block <span class="font-mono">${b.blockNumber}</span> · tx <span class="font-mono">${b.txIndex}</span>. Its contents are locked to the L1 record and cannot be altered.</p>
        </div>

        <div>
          <p class="font-medium text-slate-500 uppercase tracking-wide mb-0.5">ECDSA signatures</p>
          <ul class="space-y-0.5 list-none">${sigLines}</ul>
          <p class="mt-0.5 text-slate-500">Each sender genuinely authored their message.</p>
        </div>

        <div>
          <p class="font-medium text-slate-500 uppercase tracking-wide mb-0.5">Message commitment M</p>
          <p class="font-mono break-all text-emerald-700">${pi.m}</p>
          <p class="mt-0.5 text-slate-500">SHA-256 fingerprint recomputed from the messages above and confirmed to match the proof. This is the cryptographic link between what you read and what was proven.</p>
        </div>

      </div>

      <div class="flex items-center justify-between pt-1 border-t border-emerald-100">
        <p class="text-xs text-emerald-600">SP1 v6.1.0 · Groth16 BN254 · verified in your browser, no server involved</p>
        <a href="/proofs/${proof.file}" download="${proof.file}"
           class="text-xs text-emerald-600 hover:text-emerald-800 transition-colors shrink-0 ml-3">
          ↓ Download proof
        </a>
      </div>
    </div>`;
  btn.textContent = 'Verified ✓';
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderBatch(batch: Batch): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card space-y-3';

  const messagesHtml = batch.posts.map(post => `
    <div class="rounded-lg bg-slate-50 border border-slate-100 p-3 space-y-1">
      <div class="flex items-center justify-between gap-2">
        <a href="https://sepolia.etherscan.io/address/${escHtml(post.sender)}"
           target="_blank" rel="noopener"
           class="font-mono text-xs text-bird-700 hover:underline shrink-0"
        >${abbrev(post.sender)}</a>
        <span class="text-xs text-slate-400 shrink-0">${formatTime(post.timestamp)}</span>
      </div>
      <p class="text-sm text-slate-900 leading-snug">${escHtml(post.content)}</p>
    </div>`).join('');

  const footerHtml = batch.proof
    ? `<div class="flex items-center justify-between gap-3">
         <span class="flex items-center gap-1.5 text-xs text-emerald-600">
           <span class="h-2 w-2 rounded-full bg-emerald-500 shrink-0"></span>
           ZK proof available
         </span>
         <div class="flex items-center gap-2 shrink-0">
           <a href="/proofs/${batch.proof.file}" download="${batch.proof.file}"
              class="text-xs text-slate-400 hover:text-slate-600 transition-colors">
             ↓ Download
           </a>
           <button class="verify-btn px-3 py-1.5 rounded-lg bg-bird-600 text-white text-xs font-medium
                          hover:bg-bird-700 active:bg-bird-800 transition-colors
                          disabled:opacity-50 disabled:cursor-not-allowed">
             Verify
           </button>
         </div>
       </div>`
    : `<span class="flex items-center gap-1.5 text-xs text-slate-400">
         <span class="h-2 w-2 rounded-full bg-slate-300 shrink-0"></span>
         No proof yet
       </span>`;

  el.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-xs text-slate-500">block ${batch.block_number} · tx ${batch.tx_index}</span>
      <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">
        ${batch.posts.length} msg${batch.posts.length !== 1 ? 's' : ''}
      </span>
    </div>
    <div class="space-y-2">${messagesHtml}</div>
    <div class="pt-2 border-t border-slate-100">${footerHtml}</div>
    <div class="verify-result hidden"></div>`;

  if (batch.proof) {
    const btn = el.querySelector('.verify-btn') as HTMLButtonElement;
    const result = el.querySelector('.verify-result') as HTMLElement;
    btn.addEventListener('click', () => doVerify(batch.proof!, batch, btn, result));
  }

  return el;
}

// ── Tampered example ──────────────────────────────────────────────────────────

// Shows a message with altered content that claims to share the same proof.
// Runs the full verification: Groth16 passes (the proof is real), then M
// recomputation fails because the content doesn't match what was proven.
function renderTamperedExample(provenBatch: Batch): HTMLElement {
  const realPost = provenBatch.posts[0];
  const fakePost: Post = { ...realPost, content: 'gm. sad to be here D:' };

  const el = document.createElement('div');
  el.className = 'card space-y-3 border-dashed';

  el.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-xs text-slate-500">block ${provenBatch.block_number} · tx ${provenBatch.tx_index}</span>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">tampered</span>
        <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">1 msg</span>
      </div>
    </div>
    <div class="space-y-2">
      <div class="rounded-lg bg-slate-50 border border-slate-100 p-3 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-xs text-bird-700 shrink-0">${abbrev(realPost.sender)}</span>
          <span class="text-xs text-slate-400 shrink-0">${formatTime(realPost.timestamp)}</span>
        </div>
        <p class="text-sm text-slate-900 leading-snug">${escHtml(fakePost.content)}</p>
      </div>
    </div>
    <div class="pt-2 border-t border-slate-100">
      <div class="flex items-center justify-between gap-3">
        <span class="flex items-center gap-1.5 text-xs text-amber-600">
          <span class="h-2 w-2 rounded-full bg-amber-400 shrink-0"></span>
          Claims to have a proof
        </span>
        <button class="tamper-btn px-3 py-1.5 rounded-lg bg-bird-600 text-white text-xs font-medium
                       hover:bg-bird-700 active:bg-bird-800 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
          Verify
        </button>
      </div>
    </div>
    <div class="tamper-result hidden"></div>`;

  const btn = el.querySelector('.tamper-btn') as HTMLButtonElement;
  const result = el.querySelector('.tamper-result') as HTMLElement;
  const proofFile = provenBatch.proof!.file;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    result.classList.remove('hidden');

    result.innerHTML = spinnerHtml('Fetching proof…');
    let proofJson: ProofJson;
    try {
      const res = await fetch(`/proofs/${proofFile}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      proofJson = await res.json() as ProofJson;
    } catch (e) {
      result.innerHTML = failCard('Failed to fetch proof', `<p class="text-xs text-red-600">${escHtml(String(e))}</p>`);
      btn.disabled = false; btn.textContent = 'Retry';
      return;
    }

    result.innerHTML = spinnerHtml('Loading WASM verifier…');
    let verifier: VerifierModule;
    try {
      verifier = await getVerifier();
    } catch (e) {
      result.innerHTML = failCard('WASM verifier failed to load', `<p class="text-xs text-red-600">${escHtml(String(e))}</p>`);
      btn.disabled = false; btn.textContent = 'Retry';
      return;
    }

    // Step 3: run Groth16 with the real proof and real public inputs — it passes.
    result.innerHTML = spinnerHtml('Verifying Groth16 proof…');
    const t0 = performance.now();
    const proofBytes = fromHex(proofJson.proof);
    const piBytes = fromHex(proofJson.public_inputs);
    let groth16Err: string;
    try {
      groth16Err = verifier.verify_groth16(proofBytes, piBytes, VK_HASH);
    } catch (e) {
      groth16Err = String(e);
    }

    if (groth16Err !== '') {
      result.innerHTML = failCard('Groth16 verification failed', `<p class="text-xs text-red-600 font-mono break-all">${escHtml(groth16Err)}</p>`);
      btn.disabled = false; btn.textContent = 'Retry';
      return;
    }

    // Step 4: recompute M from the tampered message — it won't match.
    result.innerHTML = spinnerHtml('Checking message commitment…');
    const pi = decodePublicInputs(piBytes);
    const fakeM = await computeM([fakePost]);
    const ms = Math.round(performance.now() - t0);

    btn.textContent = 'Failed ✗';
    result.innerHTML = `
      <div class="rounded-lg bg-red-50 border border-red-200 p-4 space-y-3">
        <div class="flex items-center gap-2 text-red-700 font-semibold text-sm">
          <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
          Message not in proof (${ms}ms)
        </div>
        <div class="space-y-2.5 text-xs text-slate-700">
          <div>
            <p class="font-medium text-slate-500 uppercase tracking-wide mb-0.5">Groth16 proof</p>
            <p class="text-emerald-600">Valid — a real proof exists for this blob.</p>
          </div>
          <div>
            <p class="font-medium text-slate-500 uppercase tracking-wide mb-0.5">Message commitment M</p>
            <p>M in proof: <span class="font-mono">${abbrevHash(pi.m)}</span></p>
            <p>M from this message: <span class="font-mono">${abbrevHash(toHex(fakeM))}</span></p>
            <p class="mt-1 text-slate-500">The content shown does not match what was proven. M depends on exact message bytes — any change to the content produces a completely different hash. No valid proof exists for this content.</p>
          </div>
        </div>
      </div>`;
  });

  return el;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const container = document.getElementById('batches')!;
  container.innerHTML = `<div class="card">${spinnerHtml('Loading messages from bam-indexer…')}</div>`;

  let posts: Post[] = [];
  let index: ProofEntry[] = [];

  try {
    [posts, index] = await Promise.all([loadPosts(), loadIndex()]);
  } catch (e) {
    container.innerHTML = `
      <div class="card space-y-1">
        <p class="text-sm font-medium text-red-600">Failed to load messages</p>
        <p class="text-xs text-slate-500">${escHtml(String(e))}</p>
      </div>`;
    return;
  }

  const batches = groupIntoBatches(posts, index);

  if (batches.length === 0) {
    container.innerHTML = '<div class="card text-sm text-slate-500">No messages found.</div>';
    return;
  }

  container.innerHTML = '';
  for (const batch of batches) container.appendChild(renderBatch(batch));

  // Insert the tampered-entry demo right after the first proven batch.
  const provenBatch = batches.find(b => b.proof !== null);
  if (provenBatch) {
    const provenEl = container.querySelector('.card') as HTMLElement;
    provenEl?.after(renderTamperedExample(provenBatch));
  }
}

init();
