'use client';

import { useState } from 'react';
import {
  bpeDecode,
  bpeEncode,
  buildBPEDictionary,
  bytesToHex,
  compressionRatio,
  hexToBytes,
  serializeBPEDictionary,
  type BPEDictionary,
} from 'bam-sdk/browser';
import { Section, Field, TextArea, Button, Output, ErrorBox, useAction } from './ui';

const DEFAULT_CORPUS = [
  'gm', 'gm', 'gm', 'wagmi', 'wagmi', 'lfg', 'lfg', 'gm wagmi', 'lfg gm',
  'hello world', 'hello world', 'bam blob bam blob', 'good morning everyone',
].join('\n');

export function BpeSection() {
  const [corpus, setCorpus] = useState(DEFAULT_CORPUS);
  const [input, setInput] = useState('gm wagmi lfg');
  const [dict, setDict] = useState<BPEDictionary | null>(null);
  const [encoded, setEncoded] = useState<Uint8Array | null>(null);

  const build = useAction<{ size: number; preview: string }>();
  const encode = useAction<{ size: number; ratio: number; hex: string }>();
  const decode = useAction<string>();

  return (
    <Section
      id="bpe"
      title="BPE Codec"
      description="buildBPEDictionary / serializeBPEDictionary / bpeEncode / bpeDecode — pure-TS 12-bit byte-pair encoder."
    >
      <Field label="training corpus">
        <TextArea value={corpus} onChange={(e) => setCorpus(e.target.value)} rows={5} />
      </Field>
      <Button
        onClick={() =>
          build.run(
            () => {
              const built = buildBPEDictionary(new TextEncoder().encode(corpus));
              setDict(built);
              const serialized = serializeBPEDictionary(built);
              return {
                size: serialized.length,
                preview: bytesToHex(serialized.slice(0, 32)) + '…',
              };
            },
            ({ size, preview }) => `dictionary: ${size} bytes\nfirst 32B:  ${preview}`
          )
        }
      >
        buildBPEDictionary + serializeBPEDictionary
      </Button>
      <Output value={build.output} label="dictionary" />
      <ErrorBox value={build.error} />

      <Field label="input to encode (utf-8)">
        <TextArea value={input} onChange={(e) => setInput(e.target.value)} rows={3} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!dict}
          onClick={() =>
            encode.run(
              () => {
                const inputBytes = new TextEncoder().encode(input);
                const out = bpeEncode(inputBytes, dict!);
                setEncoded(out);
                return {
                  size: out.length,
                  ratio: compressionRatio(inputBytes.length, out.length),
                  hex: bytesToHex(out),
                };
              },
              ({ size, ratio, hex }) =>
                `encoded: ${size} bytes (ratio ${ratio.toFixed(2)}x)\nhex:     ${hex}`
            )
          }
        >
          bpeEncode
        </Button>
        <Button
          disabled={!dict || !encoded}
          onClick={() =>
            decode.run(
              () => new TextDecoder().decode(bpeDecode(encoded!, dict!)),
              (s) => s
            )
          }
        >
          bpeDecode
        </Button>
      </div>

      <Output value={encode.output} label="encoded" />
      <ErrorBox value={encode.error} />
      <Output value={decode.output} label="decoded" />
      <ErrorBox value={decode.error} />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        roundtrip helper: <code>hexToBytes</code> reachable for manual testing.
        <span className="hidden">{hexToBytes('0x00').length}</span>
      </p>
    </Section>
  );
}
