'use client';

import { useState } from 'react';
import { bytesToHex, hexToBytes } from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';

export function HexSection() {
  const [hex, setHex] = useState('0xdeadbeef');
  const [text, setText] = useState('Hello BAM');
  const fromHex = useAction<Uint8Array>();
  const toHex = useAction<string>();

  return (
    <Section
      id="hex"
      title="Hex Helpers"
      description="hexToBytes / bytesToHex — strict (throws on odd length / non-hex chars)."
    >
      <Field label="hex string">
        <TextInput value={hex} onChange={(e) => setHex(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button
          onClick={() =>
            fromHex.run(
              () => hexToBytes(hex),
              (b) => `${bytesToHex(b)}  (${b.length} bytes)`
            )
          }
        >
          hexToBytes(hex)
        </Button>
      </div>
      <Output value={fromHex.output} label="bytes (re-hexed)" />
      <ErrorBox value={fromHex.error} />

      <Field label="utf-8 text">
        <TextInput value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button
          onClick={() =>
            toHex.run(() => bytesToHex(new TextEncoder().encode(text)))
          }
        >
          bytesToHex(utf8(text))
        </Button>
      </div>
      <Output value={toHex.output} label="hex" />
      <ErrorBox value={toHex.error} />
    </Section>
  );
}
