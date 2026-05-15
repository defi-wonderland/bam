/**
 * Fixture generator for the on-chain BPEDecoder (Solidity port of vbuterin/SocialBlobs).
 *
 * Run from repo root after `pnpm --filter bam-sdk build`:
 *   node packages/bam-sdk/tests/vectors/decoder-bpe/_generate.mjs
 *
 * Uses bam-sdk's `encodeBatchBPE` as the single source of truth for the wire
 * format the on-chain decoder reads. Outputs (committed):
 *   dict.bin         -- 10240-byte BPE dictionary table
 *   payload-N.bin    -- per-fixture encoded batch payload
 *   manifest.json    -- fixture descriptors with expected sender/nonce/plaintext per msg
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpeDictionaryFromBytes } from '../../../dist/esm/bpe.js';
import { encodeBatchBPE } from '../../../dist/esm/codec/bpe.js';

const here = dirname(fileURLToPath(import.meta.url));

// The fixture dict is the bundled SDK v1 dict (trained from vbuterin/SocialBlobs
// corpus.txt). This ensures Foundry tests exercise the same dictionary an
// on-chain BPEDictionary deployment would hold.
const sdkDictPath = join(here, '..', '..', '..', 'data', 'dictionaries', 'bpe-v1.bin');
const fixtureDictPath = join(here, 'dict.bin');
copyFileSync(sdkDictPath, fixtureDictPath);
const dict = bpeDictionaryFromBytes(new Uint8Array(readFileSync(sdkDictPath)));

function senderHex(seed) {
  let s = '0x';
  for (let i = 0; i < 20; i++) s += ((seed + i * 11) & 0xff).toString(16).padStart(2, '0');
  return s;
}
function sigBytes(len, seed) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}
function toHex(bytes) {
  let s = '0x';
  for (const v of bytes) s += v.toString(16).padStart(2, '0');
  return s;
}

const fixtures = [];

function addFixture(name, messages, { sigUnitSize, perMessage, sigSeed }) {
  const n = messages.length;
  const trailerLen = perMessage ? sigUnitSize * n : sigUnitSize;
  const trailer = sigBytes(trailerLen, sigSeed);
  const bamMessages = messages.map((m) => ({
    sender: senderHex(m.senderSeed),
    nonce: m.nonce,
    contents: m.contents,
  }));
  const payload = encodeBatchBPE(bamMessages, trailer, dict);
  writeFileSync(join(here, `payload-${name}.bin`), payload);
  fixtures.push({
    name,
    sigUnitSize,
    perMessage,
    sigHex: toHex(trailer),
    messageCount: n,
    messages: messages.map((m) => ({
      sender: senderHex(m.senderSeed),
      nonce: m.nonce.toString(),
      contentsHex: toHex(m.contents),
    })),
    payloadFile: `payload-${name}.bin`,
  });
}

addFixture(
  'single',
  [{ senderSeed: 0x11, nonce: 1n, contents: new TextEncoder().encode('the quick brown fox') }],
  { sigUnitSize: 256, perMessage: false, sigSeed: 0xaa }
);

addFixture(
  'triple',
  [
    {
      senderSeed: 0x21,
      nonce: 1n,
      contents: new TextEncoder().encode('the quick brown fox jumps over the lazy dog'),
    },
    { senderSeed: 0x22, nonce: 2n, contents: new TextEncoder().encode('') },
    {
      senderSeed: 0x23,
      nonce: 0xffffffffffffffffn,
      contents: new TextEncoder().encode('sphinx of black quartz'),
    },
  ],
  { sigUnitSize: 256, perMessage: false, sigSeed: 0xbb }
);

addFixture(
  'ecdsa-single',
  [{ senderSeed: 0x31, nonce: 42n, contents: new TextEncoder().encode('hello world') }],
  { sigUnitSize: 65, perMessage: true, sigSeed: 0xcc }
);

addFixture(
  'ecdsa-triple',
  [
    { senderSeed: 0x51, nonce: 10n, contents: new TextEncoder().encode('first') },
    { senderSeed: 0x52, nonce: 11n, contents: new TextEncoder().encode('second message') },
    { senderSeed: 0x53, nonce: 12n, contents: new TextEncoder().encode('third one here') },
  ],
  { sigUnitSize: 65, perMessage: true, sigSeed: 0xee }
);

{
  const fullSweep = new Uint8Array(256);
  for (let i = 0; i < 256; i++) fullSweep[i] = i;
  addFixture(
    'byte-sweep',
    [{ senderSeed: 0x41, nonce: 7n, contents: fullSweep }],
    { sigUnitSize: 256, perMessage: false, sigSeed: 0xdd }
  );
}

writeFileSync(join(here, 'manifest.json'), JSON.stringify({ fixtures }, null, 2) + '\n');

console.log(`copied dict.bin from bpe-v1.bin (${dict.dictBytes.length} bytes)`);
for (const f of fixtures) {
  const mode = f.perMessage ? 'per-msg' : 'aggregate';
  console.log(
    `wrote ${f.payloadFile} (${mode}, sigUnit=${f.sigUnitSize}, ${f.messageCount} message(s))`
  );
}
