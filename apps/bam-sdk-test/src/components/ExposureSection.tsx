'use client';

import { useState } from 'react';
import {
  bytesToHex,
  buildRawMessageBytes,
  decodeExposureBatch,
  encodeExposureBatch,
  hexToBytes,
  type Address,
  type ExposureMessage,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, TextArea, Button, Output, ErrorBox, useAction } from './ui';

const DEFAULT_AUTHOR = '0x0000000000000000000000000000000000000001' as Address;
const DEFAULT_MESSAGES = ['gm', 'wagmi', 'lfg'].join('\n');

export function ExposureSection() {
  const [author, setAuthor] = useState<string>(DEFAULT_AUTHOR);
  const [messagesText, setMessagesText] = useState(DEFAULT_MESSAGES);
  const [batchHex, setBatchHex] = useState('');
  const [singleMsg, setSingleMsg] = useState('hello exposure');

  const buildRaw = useAction<Uint8Array>();
  const encode = useAction<{ size: number; offsets: number[]; lengths: number[]; hex: string }>();
  const decode = useAction<unknown>();

  function buildExposureMessages(): ExposureMessage[] {
    const lines = messagesText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.map((content, i) => ({
      author: author as Address,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: i,
      content,
    }));
  }

  return (
    <Section
      id="exposure"
      title="Exposure Batch"
      description="buildRawMessageBytes / encodeExposureBatch / decodeExposureBatch — on-chain raw layout for KZG-verifiable exposure."
    >
      <Field label="author (20-byte address)">
        <TextInput value={author} onChange={(e) => setAuthor(e.target.value)} />
      </Field>

      <Field label="single content (utf-8)">
        <TextInput value={singleMsg} onChange={(e) => setSingleMsg(e.target.value)} />
      </Field>
      <Button
        onClick={() =>
          buildRaw.run(
            () =>
              buildRawMessageBytes(
                author as Address,
                Math.floor(Date.now() / 1000),
                0,
                singleMsg
              ),
            (b) => `${bytesToHex(b)}  (${b.length} bytes)`
          )
        }
      >
        buildRawMessageBytes
      </Button>
      <Output value={buildRaw.output} label="raw bytes" />
      <ErrorBox value={buildRaw.error} />

      <Field label="messages (one per line)">
        <TextArea
          value={messagesText}
          onChange={(e) => setMessagesText(e.target.value)}
          rows={5}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            encode.run(
              () => {
                const batch = encodeExposureBatch(buildExposureMessages());
                const hex = bytesToHex(batch.data);
                setBatchHex(hex);
                return {
                  size: batch.totalSize,
                  offsets: batch.messageOffsets,
                  lengths: batch.messageLengths,
                  hex,
                };
              },
              ({ size, offsets, lengths, hex }) =>
                [
                  `totalSize:      ${size}`,
                  `messageOffsets: ${JSON.stringify(offsets)}`,
                  `messageLengths: ${JSON.stringify(lengths)}`,
                  `data (hex):     ${hex}`,
                ].join('\n')
            )
          }
        >
          encodeExposureBatch
        </Button>
        <Button
          disabled={!batchHex}
          onClick={() =>
            decode.run(
              () => decodeExposureBatch(hexToBytes(batchHex)),
              (decoded) =>
                JSON.stringify(
                  decoded,
                  (_k, v) => (v instanceof Uint8Array ? bytesToHex(v) : v),
                  2
                )
            )
          }
        >
          decodeExposureBatch
        </Button>
      </div>

      <Output value={encode.output} label="encoded exposure batch" />
      <ErrorBox value={encode.error} />
      <Output value={decode.output} label="decoded exposure batch" />
      <ErrorBox value={decode.error} />
    </Section>
  );
}
