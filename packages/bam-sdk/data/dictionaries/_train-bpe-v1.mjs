/**
 * Train the bundled BPE v1 dictionary from vbuterin/SocialBlobs corpus.txt.
 *
 * Run from repo root after `pnpm --filter bam-sdk build`:
 *   node packages/bam-sdk/data/dictionaries/_train-bpe-v1.mjs
 *
 * Inputs:
 *   - corpus.txt (55 MB) is downloaded once into this directory and cached.
 *     The file is gitignored; do not commit it.
 *
 * Outputs (committed):
 *   - bpe-v1.bin            10240-byte BPE dictionary table
 *   - bpe-v1.identity.txt   keccak256(bpe-v1.bin), for parity with the on-chain IDENTITY field
 */
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { keccak256 } from 'viem';
import { buildDictionary } from '../../dist/esm/bpe.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, 'corpus.txt');
const dictPath = join(here, 'bpe-v1.bin');
const identityPath = join(here, 'bpe-v1.identity.txt');
const CORPUS_URL = 'https://raw.githubusercontent.com/vbuterin/SocialBlobs/main/corpus.txt';
const CORPUS_BYTES = 55_651_346;

async function ensureCorpus() {
  if (existsSync(corpusPath) && statSync(corpusPath).size === CORPUS_BYTES) {
    console.log(`corpus.txt present (${CORPUS_BYTES} bytes)`);
    return;
  }
  console.log(`downloading corpus.txt from ${CORPUS_URL} ...`);
  const res = await fetch(CORPUS_URL);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(corpusPath));
  const got = statSync(corpusPath).size;
  if (got !== CORPUS_BYTES) {
    throw new Error(`corpus.txt size mismatch: got ${got}, expected ${CORPUS_BYTES}`);
  }
  console.log(`downloaded ${got} bytes`);
}

await ensureCorpus();

console.log('training dictionary...');
const t0 = performance.now();
const corpus = readFileSync(corpusPath);
const dict = buildDictionary(corpus);
const ms = ((performance.now() - t0) | 0).toString();

writeFileSync(dictPath, dict.dictBytes);
// Node's built-in `sha3-256` is the FIPS variant, not Keccak — use viem's keccak256
// so the recorded identity matches the on-chain `BPEDictionary.IDENTITY` field.
const identity = keccak256(new Uint8Array(dict.dictBytes));
writeFileSync(identityPath, identity + '\n');

console.log(`wrote ${dictPath} (${dict.dictBytes.length} bytes) in ${ms} ms`);
console.log(`IDENTITY (keccak256): ${identity}`);
console.log(`wrote ${identityPath}`);
