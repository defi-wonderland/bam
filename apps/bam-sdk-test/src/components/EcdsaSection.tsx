'use client';

import { useState } from 'react';
import {
  bytesToHex,
  computeECDSADigest,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  signECDSAWithKey,
  verifyECDSA,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';
import { DEMO_CHAIN_ID, DEMO_CONTENT_TAG, DEMO_MESSAGE_TEXT } from '@/lib/format';

export function EcdsaSection() {
  const [privateKey, setPrivateKey] = useState('');
  const [address, setAddress] = useState<string>('');
  const [appText, setAppText] = useState(DEMO_MESSAGE_TEXT);
  const [chainId, setChainId] = useState(String(DEMO_CHAIN_ID));
  const [signature, setSignature] = useState('');

  const generate = useAction<{ privateKey: string; address: string }>();
  const digest = useAction<Bytes32>();
  const sign = useAction<string>();
  const verify = useAction<boolean>();

  function buildMessage(): BAMMessage {
    if (!address) throw new Error('Generate or paste a key first to derive the sender.');
    return {
      sender: address as Address,
      nonce: 0n,
      contents: encodeContents(DEMO_CONTENT_TAG, new TextEncoder().encode(appText)),
    };
  }

  return (
    <Section
      id="ecdsa"
      title="ECDSA — Scheme 0x01 (EIP-712 over BAMMessage)"
      description="generateECDSAPrivateKey / deriveAddress / signECDSAWithKey / verifyECDSA / computeECDSADigest"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            generate.run(
              () => {
                const pk = generateECDSAPrivateKey();
                const addr = deriveAddress(pk);
                setPrivateKey(pk);
                setAddress(addr);
                return { privateKey: pk, address: addr };
              },
              ({ privateKey, address }) => `privateKey: ${privateKey}\naddress:    ${address}`
            )
          }
        >
          generateECDSAPrivateKey + deriveAddress
        </Button>
      </div>
      <Output value={generate.output} label="key + address" />
      <ErrorBox value={generate.error} />

      <Field label="private key (0x..., 32 bytes)">
        <TextInput
          value={privateKey}
          onChange={(e) => {
            const v = e.target.value;
            setPrivateKey(v);
            try {
              setAddress(v ? deriveAddress(v) : '');
            } catch {
              setAddress('');
            }
          }}
          placeholder="generate above or paste a 0x-prefixed 32-byte hex key"
        />
      </Field>
      <Field label="derived address (read-only)">
        <TextInput value={address} readOnly />
      </Field>

      <Field label="app bytes (utf-8) — wrapped in tag-prefixed contents">
        <TextInput value={appText} onChange={(e) => setAppText(e.target.value)} />
      </Field>
      <Field label="chainId">
        <TextInput value={chainId} onChange={(e) => setChainId(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!privateKey}
          onClick={() => digest.run(() => computeECDSADigest(buildMessage(), Number(chainId)))}
        >
          computeECDSADigest
        </Button>
        <Button
          disabled={!privateKey}
          onClick={() =>
            sign.run(
              () => {
                const sig = signECDSAWithKey(
                  privateKey as `0x${string}`,
                  buildMessage(),
                  Number(chainId)
                );
                setSignature(sig);
                return sig;
              },
              (sig) => `${sig}  (${(sig.length - 2) / 2} bytes)`
            )
          }
        >
          signECDSAWithKey
        </Button>
        <Button
          disabled={!signature || !address}
          onClick={() =>
            verify.run(
              () =>
                verifyECDSA(
                  buildMessage(),
                  signature as `0x${string}`,
                  address as Address,
                  Number(chainId)
                ),
              (ok) => (ok ? '✓ valid' : '✗ INVALID')
            )
          }
        >
          verifyECDSA
        </Button>
      </div>

      <Output value={digest.output} label="EIP-712 digest" />
      <ErrorBox value={digest.error} />

      <Field label="signature (65 bytes, r ‖ s ‖ v)">
        <TextInput value={signature} onChange={(e) => setSignature(e.target.value)} />
      </Field>
      <Output value={sign.output} label="signature" />
      <ErrorBox value={sign.error} />
      <Output value={verify.output} label="verifyECDSA" />
      <ErrorBox value={verify.error} />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        verify hint: format helper available — last contents hex was{' '}
        <code>{bytesToHex(new TextEncoder().encode(appText))}</code>.
      </p>
    </Section>
  );
}
