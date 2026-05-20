import { createPublicClient, http, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import {
  bytesToHex,
  deriveAddress,
  encodeBatchBPE,
  generateECDSAPrivateKey,
  hexToBytes,
  loadBPEDictionaryFromChain,
  signECDSAWithKey,
} from '../../dist/esm/index.js';

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DICT_ADDR = '0x2265A46e594a67E1d54755BF45362deaacF55A64';
const DECODER_PM = '0xCF8c9477f2EaB21Db47a66AA18805350c2F714c6';
const TAG = '0x' + '01'.repeat(32);

const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

console.log('1. loadBPEDictionaryFromChain ...');
const dict = await loadBPEDictionaryFromChain(client, DICT_ADDR);
console.log(`   ok: dictBytes=${dict.dictBytes.length}, identity=${dict.identity.slice(0, 22)}...`);

console.log('2. encode 2 messages, per-message ECDSA ...');
const messages = [];
const sigs = [];
for (const text of ['gm wagmi', 'the quick brown fox']) {
  const sk = generateECDSAPrivateKey();
  const sender = deriveAddress(sk);
  const msg = {
    sender,
    nonce: BigInt(messages.length),
    contents: new TextEncoder().encode(text),
  };
  const sig = hexToBytes(signECDSAWithKey(sk, msg, TAG, 11155111));
  messages.push(msg);
  sigs.push(sig);
}
const trailer = new Uint8Array(65 * messages.length);
for (let i = 0; i < messages.length; i++) trailer.set(sigs[i], i * 65);
const payload = encodeBatchBPE(messages, trailer, dict);
console.log(`   ok: payload=${payload.length} bytes`);

console.log('3. decode on Sepolia via eth_call ...');
const abi = parseAbi([
  'function decode(bytes payload) view returns ((address,uint64,bytes)[] messages, bytes signatureData)',
]);
const [outMessages, outSig] = await client.readContract({
  address: DECODER_PM,
  abi,
  functionName: 'decode',
  args: [bytesToHex(payload)],
});
console.log(`   ok: decoded ${outMessages.length} messages, sigData=${(outSig.length - 2) / 2} bytes`);
for (let i = 0; i < outMessages.length; i++) {
  const [sender, nonce, contents] = outMessages[i];
  const textBytes = hexToBytes(contents);
  // After the tag-binding rework, `contents` is the app body bytes
  // directly; no per-message tag prefix.
  const body = new TextDecoder().decode(textBytes);
  console.log(`   [${i}] sender=${sender} nonce=${nonce} text=${JSON.stringify(body)}`);
}
