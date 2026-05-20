'use client';

import { useState } from 'react';
import {
  bytesToHex,
  computeMessageHash,
  computeMessageId,
  type Address,
  type Bytes32,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';
import { DEMO_CONTENT_TAG, DEMO_MESSAGE_TEXT } from '@/lib/format';

const DEMO_SENDER = '0x0000000000000000000000000000000000000001' as Address;
const DEMO_BATCH_HASH = ('0x' + 'ab'.repeat(32)) as Bytes32;

export function MessageSection() {
  const [sender, setSender] = useState<string>(DEMO_SENDER);
  const [nonce, setNonce] = useState('0');
  const [tag, setTag] = useState<string>(DEMO_CONTENT_TAG);
  const [appText, setAppText] = useState(DEMO_MESSAGE_TEXT);
  const [batchHash, setBatchHash] = useState<string>(DEMO_BATCH_HASH);

  const body = useAction<Uint8Array>();
  const hash = useAction<Bytes32>();
  const id = useAction<Bytes32>();

  function buildContents() {
    return new TextEncoder().encode(appText);
  }

  return (
    <Section
      id="message"
      title="Message Primitives"
      description="computeMessageHash / computeMessageId (ERC-8180). `contents` is an opaque app body; `contentTag` is supplied separately and bound into the hash."
    >
      <Field label="sender (20-byte address)">
        <TextInput value={sender} onChange={(e) => setSender(e.target.value)} />
      </Field>
      <Field label="contentTag (32-byte hex)">
        <TextInput value={tag} onChange={(e) => setTag(e.target.value)} />
      </Field>
      <Field label="nonce (uint64)">
        <TextInput value={nonce} onChange={(e) => setNonce(e.target.value)} />
      </Field>
      <Field label="contents (utf-8 body)">
        <TextInput value={appText} onChange={(e) => setAppText(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            body.run(
              () => buildContents(),
              (b) => `${bytesToHex(b)}  (${b.length} bytes)`
            )
          }
        >
          contents (utf-8 bytes)
        </Button>
        <Button
          onClick={() =>
            hash.run(() =>
              computeMessageHash(
                sender as Address,
                tag as Bytes32,
                BigInt(nonce),
                buildContents()
              )
            )
          }
        >
          computeMessageHash
        </Button>
      </div>

      <Output value={body.output} label="contents (hex)" />
      <ErrorBox value={body.error} />
      <Output value={hash.output} label="messageHash" />
      <ErrorBox value={hash.error} />

      <hr className="border-neutral-200 dark:border-neutral-800 my-2" />
      <Field label="batchContentHash (32-byte hex — versionedHash or keccak256(batchData))">
        <TextInput value={batchHash} onChange={(e) => setBatchHash(e.target.value)} />
      </Field>
      <Button
        onClick={() =>
          id.run(() =>
            computeMessageId(
              sender as Address,
              tag as Bytes32,
              BigInt(nonce),
              batchHash as Bytes32
            )
          )
        }
      >
        computeMessageId
      </Button>
      <Output value={id.output} label="messageId" />
      <ErrorBox value={id.error} />
    </Section>
  );
}
