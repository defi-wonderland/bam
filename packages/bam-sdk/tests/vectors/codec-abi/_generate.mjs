/**
 * Fixture generator for the v1 ABI batch codec.
 *
 * Run from repo root after `pnpm --filter bam-sdk build`:
 *   node packages/bam-sdk/tests/vectors/codec-abi/_generate.mjs
 *
 * Re-runnable. Output is committed under this directory; reviewers can
 * confirm fixtures match the SDK by re-running this and `git diff`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBatchABI } from '../../../dist/esm/codec/abi.js';

const here = dirname(fileURLToPath(import.meta.url));

function bytesToHex(b) {
  let s = '0x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function hex2(n) {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function makeMessage(seed, contentsLen) {
  const sender = '0x' + hex2(seed).repeat(20);
  const contents = new Uint8Array(contentsLen);
  for (let i = 0; i < contentsLen; i++) contents[i] = (seed + i * 7) & 0xff;
  return { sender, nonce: BigInt(seed * 1000 + 1), contents };
}

function makeSignature(seed) {
  const sig = new Uint8Array(65);
  for (let i = 0; i < 65; i++) sig[i] = (seed * 13 + i) & 0xff;
  return sig;
}

function makeBatch(n, contentsLenForSeed) {
  const messages = [];
  const signatures = [];
  for (let i = 1; i <= n; i++) {
    messages.push(makeMessage(i, contentsLenForSeed(i)));
    signatures.push(makeSignature(i));
  }
  return { messages, signatures };
}

function fixture(name, batch) {
  const expected = encodeBatchABI(batch.messages, batch.signatures);
  const obj = {
    name,
    messageCount: batch.messages.length,
    messages: batch.messages.map((m) => ({
      sender: m.sender,
      nonce: m.nonce.toString(),
      contents: bytesToHex(m.contents),
    })),
    signatures: batch.signatures.map((s) => bytesToHex(s)),
    expectedBytes: bytesToHex(expected),
  };
  const path = join(here, `${name}.json`);
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  console.log(`wrote ${path} (${expected.length} bytes)`);
}

fixture('empty', { messages: [], signatures: [] });
fixture('one-message', makeBatch(1, () => 40));
fixture('four-messages', makeBatch(4, (i) => 32 + i * 8));
// 256 messages — same shape as the unit test's stress case.
fixture('two-fifty-six-messages', makeBatch(256, (i) => 16 + ((i - 1) % 7) * 4));
