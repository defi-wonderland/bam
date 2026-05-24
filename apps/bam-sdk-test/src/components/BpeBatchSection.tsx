'use client';

import { useMemo, useState } from 'react';
import {
  bpeDictionaryFromBytes,
  buildBPEDictionary,
  bytesToHex,
  decodeBatchBPE,
  decodeBatchBPEPerMessage,
  deriveAddress,
  encodeBatchBPE,
  generateECDSAPrivateKey,
  hexToBytes,
  loadBPEDictionaryFromChain,
  signECDSAWithKey,
  type BAMMessage,
  type BPEDictionary,
} from 'bam-sdk/browser';
import { createPublicClient, http, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { Section, Field, TextArea, TextInput, Button, Output, ErrorBox, useAction } from './ui';
import { DEMO_CHAIN_ID, DEMO_CONTENT_TAG, SEPOLIA_BPE, SEPOLIA_RPC_URL } from '@/lib/format';

const DEFAULT_CORPUS = [
  'the quick brown fox jumps over the lazy dog. ',
  'pack my box with five dozen liquor jugs. ',
  'how vexingly quick daft zebras jump! ',
  'sphinx of black quartz, judge my vow. ',
  'bam blob bam blob ',
]
  .join('')
  .repeat(40);

const DEFAULT_MESSAGES = ['the quick brown fox', 'sphinx of black quartz', 'gm wagmi lfg'].join(
  '\n'
);

type SigMode = 'aggregate' | 'per-message';

// One client per page load — Sepolia public RPC works fine for read-only eth_call.
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

const BPE_DECODER_ABI = parseAbi([
  'function decode(bytes payload) view returns ((address,uint64,bytes)[] messages, bytes signatureData)',
]);

export function BpeBatchSection() {
  const [corpus, setCorpus] = useState(DEFAULT_CORPUS);
  const [messagesText, setMessagesText] = useState(DEFAULT_MESSAGES);
  const [chainId, setChainId] = useState(String(DEMO_CHAIN_ID));
  const [sigMode, setSigMode] = useState<SigMode>('per-message');
  const [sigUnitSize, setSigUnitSize] = useState('65');
  const [dict, setDict] = useState<BPEDictionary | null>(null);
  const [dictSource, setDictSource] = useState<'built' | 'bundled' | 'sepolia' | null>(null);
  const [payloadHex, setPayloadHex] = useState('');

  const build = useAction<{ size: number }>();
  const loadBundled = useAction<{ size: number; identityPrefix: string }>();
  const loadChain = useAction<{ contract: string; identity: string }>();
  const encode = useAction<{ size: number; hex: string }>();
  const decode = useAction<unknown>();
  const decodeChain = useAction<unknown>();

  const lines = useMemo(
    () =>
      messagesText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    [messagesText]
  );

  function buildSignedBatch(): { messages: BAMMessage[]; trailer: Uint8Array } {
    if (!dict) throw new Error('Build the dictionary first.');
    if (lines.length === 0) throw new Error('At least one message line is required.');
    const unit = Number(sigUnitSize);
    if (!Number.isFinite(unit) || unit <= 0) throw new Error('sigUnitSize must be a positive integer.');

    const messages: BAMMessage[] = [];
    const perMsgSigs: Uint8Array[] = [];

    for (let i = 0; i < lines.length; i++) {
      const sk = generateECDSAPrivateKey();
      const sender = deriveAddress(sk);
      const msg: BAMMessage = {
        sender,
        nonce: BigInt(i),
        contents: new TextEncoder().encode(lines[i]),
      };
      messages.push(msg);
      if (sigMode === 'per-message') {
        const sigHex = signECDSAWithKey(sk as `0x${string}`, msg, DEMO_CONTENT_TAG, Number(chainId));
        const sig = hexToBytes(sigHex);
        const padded = new Uint8Array(unit);
        padded.set(sig.subarray(0, Math.min(unit, sig.length)));
        perMsgSigs.push(padded);
      }
    }

    let trailer: Uint8Array;
    if (sigMode === 'aggregate') {
      trailer = new Uint8Array(unit);
      for (let i = 0; i < unit; i++) trailer[i] = (i * 13 + lines.length) & 0xff;
    } else {
      trailer = new Uint8Array(unit * messages.length);
      for (let i = 0; i < messages.length; i++) trailer.set(perMsgSigs[i], i * unit);
    }

    return { messages, trailer };
  }

  return (
    <Section
      id="bpe-batch"
      title="BPE Batch Codec"
      description="encodeBatchBPE / decodeBatchBPE — wire format read by the on-chain BPEDecoder. Pick a dictionary source (built locally, bundled v1, or fetched from the deployed Sepolia BPEDictionary), then encode and optionally decode via eth_call on the matching deployed decoder."
    >
      <Field label="training corpus (used only by buildBPEDictionary)">
        <TextArea value={corpus} onChange={(e) => setCorpus(e.target.value)} rows={4} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            build.run(
              () => {
                const built = buildBPEDictionary(new TextEncoder().encode(corpus));
                setDict(built);
                setDictSource('built');
                return { size: built.dictBytes.length };
              },
              ({ size }) => `built dictionary: ${size} bytes (from corpus above)`
            )
          }
        >
          buildBPEDictionary
        </Button>
        <Button
          onClick={() =>
            loadBundled.run(
              async () => {
                const res = await fetch('/bpe-v1.bin');
                if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const loaded = bpeDictionaryFromBytes(bytes);
                setDict(loaded);
                setDictSource('bundled');
                const buf = await crypto.subtle.digest('SHA-256', bytes);
                const hex = bytesToHex(new Uint8Array(buf));
                return { size: bytes.length, identityPrefix: hex.slice(0, 18) + '…' };
              },
              ({ size, identityPrefix }) =>
                `bundled v1 dict: ${size} bytes\nsha256 prefix: ${identityPrefix}`
            )
          }
        >
          load bundled v1 dict
        </Button>
        <Button
          onClick={() =>
            loadChain.run(
              async () => {
                const loaded = await loadBPEDictionaryFromChain(
                  sepoliaClient,
                  SEPOLIA_BPE.dictionary
                );
                setDict(loaded);
                setDictSource('sepolia');
                return { contract: loaded.contractAddress, identity: loaded.identity };
              },
              ({ contract, identity }) =>
                `loaded BPEDictionary from Sepolia\ncontract: ${contract}\nIDENTITY: ${identity}`
            )
          }
        >
          load from Sepolia
        </Button>
      </div>
      <Output value={build.output} label="dictionary (built)" />
      <ErrorBox value={build.error} />
      <Output value={loadBundled.output} label="dictionary (bundled)" />
      <ErrorBox value={loadBundled.error} />
      <Output value={loadChain.output} label="dictionary (Sepolia)" />
      <ErrorBox value={loadChain.error} />
      {dictSource && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          active dict source: <strong>{dictSource}</strong>
        </p>
      )}

      <Field label="messages (one per line)">
        <TextArea
          value={messagesText}
          onChange={(e) => setMessagesText(e.target.value)}
          rows={4}
        />
      </Field>

      <div className="flex flex-wrap gap-3 items-end">
        <Field label="signature mode">
          <select
            value={sigMode}
            onChange={(e) => {
              const next = e.target.value as SigMode;
              setSigMode(next);
              setSigUnitSize(next === 'per-message' ? '65' : '256');
            }}
            className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
          >
            <option value="per-message">per-message (trailer = unit × N)</option>
            <option value="aggregate">aggregate (trailer = unit, fixed)</option>
          </select>
        </Field>
        <Field label="sigUnitSize">
          <TextInput value={sigUnitSize} onChange={(e) => setSigUnitSize(e.target.value)} />
        </Field>
        <Field label="chainId">
          <TextInput value={chainId} onChange={(e) => setChainId(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!dict}
          onClick={() =>
            encode.run(
              () => {
                const { messages, trailer } = buildSignedBatch();
                const payload = encodeBatchBPE(messages, trailer, dict!);
                const hex = bytesToHex(payload);
                setPayloadHex(hex);
                return { size: payload.length, hex };
              },
              ({ size, hex }) => `size: ${size} bytes\nhex:  ${hex}`
            )
          }
        >
          encodeBatchBPE
        </Button>
        <Button
          disabled={!dict || !payloadHex}
          onClick={() =>
            decode.run(
              () => {
                const bytes = hexToBytes(payloadHex);
                const unit = Number(sigUnitSize);
                const decoded =
                  sigMode === 'per-message'
                    ? decodeBatchBPEPerMessage(bytes, dict!, unit)
                    : decodeBatchBPE(bytes, dict!, unit);
                return decoded;
              },
              (decoded) =>
                JSON.stringify(
                  decoded,
                  (_k, v) => {
                    if (typeof v === 'bigint') return v.toString();
                    if (v instanceof Uint8Array) return bytesToHex(v);
                    return v;
                  },
                  2
                )
            )
          }
        >
          decodeBatchBPE (SDK)
        </Button>
        <Button
          disabled={!payloadHex}
          onClick={() =>
            decodeChain.run(
              async () => {
                const decoderAddress =
                  sigMode === 'per-message'
                    ? SEPOLIA_BPE.decoderPerMessage
                    : SEPOLIA_BPE.decoderAggregate;
                const [messages, signatureData] = (await sepoliaClient.readContract({
                  address: decoderAddress,
                  abi: BPE_DECODER_ABI,
                  functionName: 'decode',
                  args: [payloadHex as `0x${string}`],
                })) as readonly [
                  ReadonlyArray<readonly [`0x${string}`, bigint, `0x${string}`]>,
                  `0x${string}`,
                ];
                return {
                  decoderAddress,
                  messages: messages.map(([sender, nonce, contents]) => ({
                    sender,
                    nonce: nonce.toString(),
                    contentsHex: contents,
                    contentsText: tryUtf8(contents),
                  })),
                  signatureDataLen: (signatureData.length - 2) / 2,
                  signatureDataHex: signatureData,
                };
              },
              (result) => JSON.stringify(result, null, 2)
            )
          }
        >
          decode on Sepolia (eth_call)
        </Button>
      </div>

      <Output value={encode.output} label="encoded batch" />
      <ErrorBox value={encode.error} />
      <Output value={decode.output} label="decoded batch (SDK)" />
      <ErrorBox value={decode.error} />
      <Output value={decodeChain.output} label="decoded batch (on Sepolia)" />
      <ErrorBox value={decodeChain.error} />
    </Section>
  );
}

function tryUtf8(hex: `0x${string}`): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(hexToBytes(hex));
  } catch {
    return '<not utf-8>';
  }
}
