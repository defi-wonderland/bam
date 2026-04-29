'use client';

import { useState } from 'react';
import {
  aggregateBLS,
  bytesToHex,
  deriveBLSPublicKey,
  generateBLSPrivateKey,
  hexToBytes,
  serializeBLSPrivateKey,
  serializeBLSPublicKey,
  serializeBLSSignature,
  signBLS,
  verifyAggregateBLS,
  verifyBLS,
  type BLSPrivateKey,
  type BLSPublicKey,
  type BLSSignature,
  type Bytes32,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';

const DEMO_HASH_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const DEMO_HASH_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

interface KeyPair {
  privateKey: BLSPrivateKey;
  publicKey: BLSPublicKey;
}

export function BlsSection() {
  const [keyA, setKeyA] = useState<KeyPair | null>(null);
  const [keyB, setKeyB] = useState<KeyPair | null>(null);
  const [hashA, setHashA] = useState<string>(DEMO_HASH_A);
  const [hashB, setHashB] = useState<string>(DEMO_HASH_B);
  const [sigA, setSigA] = useState<BLSSignature | null>(null);
  const [sigB, setSigB] = useState<BLSSignature | null>(null);
  const [aggSig, setAggSig] = useState<BLSSignature | null>(null);

  const gen = useAction<{ a: KeyPair; b: KeyPair }>();
  const sign = useAction<{ a: BLSSignature; b: BLSSignature }>();
  const verifyA = useAction<boolean>();
  const aggregate = useAction<BLSSignature>();
  const verifyAgg = useAction<boolean>();

  return (
    <Section
      id="bls"
      title="BLS — Scheme 0x02 building blocks"
      description="generateBLSPrivateKey / deriveBLSPublicKey / signBLS / verifyBLS / aggregateBLS / verifyAggregateBLS"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            gen.run(
              () => {
                const a: KeyPair = (() => {
                  const sk = generateBLSPrivateKey();
                  return { privateKey: sk, publicKey: deriveBLSPublicKey(sk) };
                })();
                const b: KeyPair = (() => {
                  const sk = generateBLSPrivateKey();
                  return { privateKey: sk, publicKey: deriveBLSPublicKey(sk) };
                })();
                setKeyA(a);
                setKeyB(b);
                return { a, b };
              },
              ({ a, b }) =>
                [
                  `signer A privKey: ${serializeBLSPrivateKey(a.privateKey)}`,
                  `signer A pubKey:  ${serializeBLSPublicKey(a.publicKey)}`,
                  `signer B privKey: ${serializeBLSPrivateKey(b.privateKey)}`,
                  `signer B pubKey:  ${serializeBLSPublicKey(b.publicKey)}`,
                ].join('\n')
            )
          }
        >
          generate two BLS key pairs
        </Button>
      </div>
      <Output value={gen.output} label="key pairs" />
      <ErrorBox value={gen.error} />

      <Field label="messageHash A (32-byte hex)">
        <TextInput value={hashA} onChange={(e) => setHashA(e.target.value)} />
      </Field>
      <Field label="messageHash B (32-byte hex)">
        <TextInput value={hashB} onChange={(e) => setHashB(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!keyA || !keyB}
          onClick={() =>
            sign.run(
              async () => {
                const a = await signBLS(keyA!.privateKey, hashA as Bytes32);
                const b = await signBLS(keyB!.privateKey, hashB as Bytes32);
                setSigA(a);
                setSigB(b);
                return { a, b };
              },
              ({ a, b }) =>
                `sigA: ${serializeBLSSignature(a)}\nsigB: ${serializeBLSSignature(b)}`
            )
          }
        >
          signBLS (A and B)
        </Button>
        <Button
          disabled={!keyA || !sigA}
          onClick={() =>
            verifyA.run(
              () => verifyBLS(keyA!.publicKey, hashA as Bytes32, sigA!),
              (ok) => (ok ? '✓ A valid' : '✗ A INVALID')
            )
          }
        >
          verifyBLS (A)
        </Button>
        <Button
          disabled={!sigA || !sigB}
          onClick={() =>
            aggregate.run(
              () => {
                const agg = aggregateBLS([sigA!, sigB!]);
                setAggSig(agg);
                return agg;
              },
              (agg) => serializeBLSSignature(agg)
            )
          }
        >
          aggregateBLS
        </Button>
        <Button
          disabled={!aggSig || !keyA || !keyB}
          onClick={() =>
            verifyAgg.run(
              () =>
                verifyAggregateBLS(
                  [keyA!.publicKey, keyB!.publicKey],
                  [hashA as Bytes32, hashB as Bytes32],
                  aggSig!
                ),
              (ok) => (ok ? '✓ aggregate valid' : '✗ aggregate INVALID')
            )
          }
        >
          verifyAggregateBLS
        </Button>
      </div>

      <Output value={sign.output} label="signatures" />
      <ErrorBox value={sign.error} />
      <Output value={verifyA.output} label="verifyBLS(A)" />
      <ErrorBox value={verifyA.error} />
      <Output value={aggregate.output} label="aggregate" />
      <ErrorBox value={aggregate.error} />
      <Output value={verifyAgg.output} label="verifyAggregateBLS" />
      <ErrorBox value={verifyAgg.error} />

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Note: BLS sign/verify are async. Hex helpers reachable via{' '}
        <code>bytesToHex</code>/<code>hexToBytes</code> (used internally:{' '}
        {bytesToHex(hexToBytes(hashA)).slice(0, 18)}…).
      </p>
    </Section>
  );
}
