'use client';

import { useState } from 'react';
import {
  bytesToHex,
  decodeBatch,
  deriveAddress,
  encodeBatch,
  encodeContents,
  estimateBatchSize,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
  type BAMMessage,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, TextArea, Button, Output, ErrorBox, useAction } from './ui';
import { DEMO_CHAIN_ID, DEMO_CONTENT_TAG } from '@/lib/format';

const DEFAULT_MESSAGES = ['gm', 'wagmi', 'lfg'].join('\n');

export function BatchSection() {
  const [messagesText, setMessagesText] = useState(DEFAULT_MESSAGES);
  const [chainId, setChainId] = useState(String(DEMO_CHAIN_ID));
  const [batchHex, setBatchHex] = useState('');

  const estimate = useAction<number>();
  const encode = useAction<{ size: number; hex: string }>();
  const decode = useAction<unknown>();

  function buildSigned(): { messages: BAMMessage[]; signatures: Uint8Array[] } {
    const lines = messagesText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new Error('At least one message line is required.');
    const messages: BAMMessage[] = [];
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < lines.length; i++) {
      const sk = generateECDSAPrivateKey();
      const sender = deriveAddress(sk);
      const msg: BAMMessage = {
        sender,
        nonce: BigInt(i),
        contents: encodeContents(DEMO_CONTENT_TAG, new TextEncoder().encode(lines[i])),
      };
      const sigHex = signECDSAWithKey(sk as `0x${string}`, msg, Number(chainId));
      messages.push(msg);
      signatures.push(hexToBytes(sigHex));
    }
    return { messages, signatures };
  }

  return (
    <Section
      id="batch"
      title="Batch Codec"
      description="encodeBatch / decodeBatch / estimateBatchSize. Each line below becomes a message; a fresh ECDSA key signs it."
    >
      <Field label="messages (one per line)">
        <TextArea
          value={messagesText}
          onChange={(e) => setMessagesText(e.target.value)}
          rows={5}
        />
      </Field>
      <Field label="chainId">
        <TextInput value={chainId} onChange={(e) => setChainId(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            estimate.run(
              () => {
                const { messages } = buildSigned();
                return estimateBatchSize(messages);
              },
              (n) => `${n} bytes`
            )
          }
        >
          estimateBatchSize
        </Button>
        <Button
          onClick={() =>
            encode.run(
              () => {
                const { messages, signatures } = buildSigned();
                const batch = encodeBatch(messages, signatures);
                const hex = bytesToHex(batch.data);
                setBatchHex(hex);
                return { size: batch.size, hex };
              },
              ({ size, hex }) => `size: ${size} bytes\nhex:  ${hex}`
            )
          }
        >
          encodeBatch
        </Button>
        <Button
          disabled={!batchHex}
          onClick={() =>
            decode.run(
              () => {
                const decoded = decodeBatch(hexToBytes(batchHex));
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
          decodeBatch
        </Button>
      </div>

      <Output value={estimate.output} label="estimate" />
      <ErrorBox value={estimate.error} />
      <Output value={encode.output} label="encoded batch" />
      <ErrorBox value={encode.error} />
      <Output value={decode.output} label="decoded batch" />
      <ErrorBox value={decode.error} />
    </Section>
  );
}
