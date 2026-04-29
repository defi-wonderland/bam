'use client';

import { useState } from 'react';
import {
  bytesToHex,
  compressionRatio,
  decompress,
  getDecompressedSize,
  hexToBytes,
  isCompressed,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';

export function CompressionSection() {
  const [hex, setHex] = useState('');
  const [origSize, setOrigSize] = useState('1000');
  const [compSize, setCompSize] = useState('109');

  const checkMagic = useAction<boolean>();
  const decompressed = useAction<{ size: number; hex: string }>();
  const sizeAction = useAction<number>();
  const ratio = useAction<number>();

  return (
    <Section
      id="compression"
      title="Compression (Zstd)"
      description="decompress / isCompressed / getDecompressedSize / compressionRatio. Compression itself is Node-only in the SDK today; decompress runs in the browser via fzstd."
    >
      <Field label="zstd-framed bytes (hex) — paste output from a node-side compress()">
        <TextInput
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          placeholder="0x28b52ffd…"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!hex}
          onClick={() =>
            checkMagic.run(
              () => isCompressed(hexToBytes(hex)),
              (v) => (v ? '✓ has zstd magic' : '✗ no zstd magic')
            )
          }
        >
          isCompressed
        </Button>
        <Button
          disabled={!hex}
          onClick={() =>
            sizeAction.run(
              () => getDecompressedSize(hexToBytes(hex)),
              (n) => `${n} bytes`
            )
          }
        >
          getDecompressedSize
        </Button>
        <Button
          disabled={!hex}
          onClick={() =>
            decompressed.run(
              () => {
                const out = decompress(hexToBytes(hex));
                return { size: out.length, hex: bytesToHex(out) };
              },
              ({ size, hex }) => `${size} bytes\n${hex}`
            )
          }
        >
          decompress
        </Button>
      </div>

      <Output value={checkMagic.output} label="isCompressed" />
      <ErrorBox value={checkMagic.error} />
      <Output value={sizeAction.output} label="decompressed size" />
      <ErrorBox value={sizeAction.error} />
      <Output value={decompressed.output} label="decompressed" />
      <ErrorBox value={decompressed.error} />

      <hr className="border-neutral-200 dark:border-neutral-800 my-2" />
      <Field label="original size (bytes)">
        <TextInput value={origSize} onChange={(e) => setOrigSize(e.target.value)} />
      </Field>
      <Field label="compressed size (bytes)">
        <TextInput value={compSize} onChange={(e) => setCompSize(e.target.value)} />
      </Field>
      <Button
        onClick={() =>
          ratio.run(
            () => compressionRatio(Number(origSize), Number(compSize)),
            (r) => `${r.toFixed(3)}×`
          )
        }
      >
        compressionRatio
      </Button>
      <Output value={ratio.output} label="ratio" />
      <ErrorBox value={ratio.error} />
    </Section>
  );
}
