import './style.css';

const VK_HASH = '0x009719dd1c4447c79d11830b020ce5c1edf7f3b3019031e26dbe89a4ef5f6c9c';

interface ProofJson {
  proof: string;
  public_inputs: string;
  vk_hash: string;
}

interface VerifierModule {
  default: (wasmUrl?: string) => Promise<void>;
  verify_groth16: (proof: Uint8Array, public_inputs: Uint8Array, vk_hash: string) => string;
}

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function setResult(html: string) {
  const el = document.getElementById('verify-result')!;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function setBtnState(disabled: boolean, label: string) {
  const btn = document.getElementById('verify-btn') as HTMLButtonElement;
  btn.disabled = disabled;
  btn.textContent = label;
}

async function loadVerifier(): Promise<VerifierModule> {
  console.log('[bam-verifier] importing WASM module from /verifier/sp1_wasm_verifier.js');
  // new Function escapes Vite's static import analyzer, which blocks dynamic imports of
  // JS files from public/ in dev mode even with @vite-ignore.
  const mod: VerifierModule = await (new Function('s', 'return import(s)'))('/verifier/sp1_wasm_verifier.js');
  console.log('[bam-verifier] initialising WASM binary from /verifier/sp1_wasm_verifier_bg.wasm');
  await mod.default('/verifier/sp1_wasm_verifier_bg.wasm');
  console.log('[bam-verifier] WASM verifier ready');
  return mod;
}

async function doVerify() {
  console.group('[bam-verifier] starting verification');
  setBtnState(true, 'Loading…');
  setResult(`
    <div class="flex items-center gap-2 text-sm text-slate-500">
      <svg class="animate-spin h-4 w-4 text-bird-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
      </svg>
      Fetching proof…
    </div>
  `);

  let proofJson: ProofJson;
  try {
    console.log('[bam-verifier] step 1/3 — fetching /proof.json');
    const res = await fetch('/proof.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    proofJson = await res.json() as ProofJson;
    console.log('[bam-verifier] proof.json loaded', {
      proof_bytes: proofJson.proof.length / 2,
      public_inputs_bytes: proofJson.public_inputs.length / 2,
      vk_hash: proofJson.vk_hash,
    });
  } catch (e) {
    console.error('[bam-verifier] failed to fetch proof.json', e);
    console.groupEnd();
    setResult(`<div class="text-sm text-red-600">Failed to fetch proof: ${e}</div>`);
    setBtnState(false, 'Fetch & verify proof');
    return;
  }

  setResult(`
    <div class="flex items-center gap-2 text-sm text-slate-500">
      <svg class="animate-spin h-4 w-4 text-bird-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
      </svg>
      Loading WASM verifier…
    </div>
  `);

  let verifier: VerifierModule;
  try {
    console.log('[bam-verifier] step 2/3 — loading SP1 WASM verifier (sp1-verifier compiled to wasm32)');
    verifier = await loadVerifier();
  } catch (e) {
    console.error('[bam-verifier] WASM verifier failed to load', e);
    console.groupEnd();
    setResult(`
      <div class="text-sm text-red-600 space-y-1">
        <p>WASM verifier not found.</p>
        <p class="text-slate-500">Build it first — see the README for the <code class="bg-slate-100 px-1 rounded">wasm-pack</code> step.</p>
      </div>
    `);
    setBtnState(false, 'Fetch & verify proof');
    return;
  }

  setResult(`
    <div class="flex items-center gap-2 text-sm text-slate-500">
      <svg class="animate-spin h-4 w-4 text-bird-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path>
      </svg>
      Verifying proof locally…
    </div>
  `);

  const t0 = performance.now();
  let err: string;
  try {
    console.log('[bam-verifier] step 3/3 — calling verify_groth16(proof, public_inputs, vk_hash)');
    console.log('[bam-verifier] vk_hash (SP1 program key):', VK_HASH);
    const proofBytes = fromHex(proofJson.proof);
    const publicInputsBytes = fromHex(proofJson.public_inputs);
    console.log('[bam-verifier] proof:', proofBytes.length, 'bytes | public_inputs:', publicInputsBytes.length, 'bytes');
    err = verifier.verify_groth16(proofBytes, publicInputsBytes, VK_HASH);
    console.log(`[bam-verifier] verify_groth16 result: ${err === '' ? 'OK' : err}`);
  } catch (e) {
    console.error('[bam-verifier] verify_groth16 threw', e);
    console.groupEnd();
    setResult(`<div class="text-sm text-red-600">Verification error: ${e}</div>`);
    setBtnState(false, 'Fetch & verify proof');
    return;
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`[bam-verifier] completed in ${ms}ms`);
  console.groupEnd();

  if (err === '') {
    setResult(`
      <div class="rounded-lg bg-emerald-50 border border-emerald-200 p-4 space-y-2">
        <div class="flex items-center gap-2 text-emerald-700 font-medium">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
          </svg>
          Proof verified locally
        </div>
        <p class="text-sm text-emerald-800">
          This message was signed by <span class="font-mono">0x2f47…4cd5f</span> and committed to
          blob <span class="font-mono">0x01e88c3f…76819</span> on Sepolia block 10767913.
          Verified using SP1 v6.1.0 WASM verifier in ${ms}ms.
        </p>
        <p class="text-xs text-emerald-600">
          The proof certifies: KZG opening verified · ECDSA signature valid · message decoded correctly
        </p>
      </div>
    `);
  } else {
    setResult(`
      <div class="rounded-lg bg-red-50 border border-red-200 p-4">
        <div class="flex items-center gap-2 text-red-700 font-medium">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
          Verification failed
        </div>
        <p class="text-sm text-red-600 mt-1">${err}</p>
      </div>
    `);
  }

  setBtnState(false, 'Verify again');
}

document.getElementById('verify-btn')!.addEventListener('click', () => {
  doVerify().catch(console.error);
});
