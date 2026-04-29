'use client';

import { useState } from 'react';
import {
  computeECDSADigest,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  signECDSA,
  signECDSAWithKey,
  verifyECDSA,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk/browser';
import { Section, Field, TextInput, Button, Output, ErrorBox, useAction } from './ui';
import { DEMO_CHAIN_ID, DEMO_CONTENT_TAG, DEMO_MESSAGE_TEXT } from '@/lib/format';
import { useInjectedWallet } from '@/lib/wallet';

export function EcdsaSection() {
  const [privateKey, setPrivateKey] = useState('');
  const [address, setAddress] = useState<string>('');
  const [appText, setAppText] = useState(DEMO_MESSAGE_TEXT);
  const [chainId, setChainId] = useState(String(DEMO_CHAIN_ID));
  const [signature, setSignature] = useState('');
  /**
   * Tracks which signing path produced the current signature so verify
   * can route to the matching sender/chain. `null` means the signature
   * was pasted/edited by hand — fall back to the headless inputs.
   */
  const [signatureSource, setSignatureSource] = useState<'headless' | 'wallet' | null>(null);

  function updateSignature(value: string, source: 'headless' | 'wallet' | null) {
    setSignature(value);
    setSignatureSource(source);
  }

  const wallet = useInjectedWallet();
  const connect = useAction<void>();
  const walletSign = useAction<string>();

  const generate = useAction<{ privateKey: string; address: string }>();
  const digest = useAction<Bytes32>();
  const sign = useAction<string>();
  const verify = useAction<boolean>();

  function buildMessage(sender: Address): BAMMessage {
    return {
      sender,
      nonce: 0n,
      contents: encodeContents(DEMO_CONTENT_TAG, new TextEncoder().encode(appText)),
    };
  }

  const headlessSender = (address || null) as Address | null;
  /**
   * Validate the headless chainId input before using it. `Number("foo")`
   * is `NaN`, which is still typeof `number` and would slip past loose
   * checks. Without this, an unparseable input would silently flow into
   * `verifyECDSA`/`signECDSAWithKey` — verify swallows every failure
   * into `false`, so "bad input" looks identical to "invalid signature".
   */
  const parsedChainId = Number(chainId);
  const headlessChainId: number | null =
    chainId.trim() !== '' && Number.isSafeInteger(parsedChainId) && parsedChainId > 0
      ? parsedChainId
      : null;
  const chainIdError =
    headlessChainId === null && chainId.trim() !== ''
      ? `"${chainId}" is not a positive integer`
      : '';

  const useWalletForVerify = signatureSource === 'wallet' && !!wallet.address;
  const verifySender: Address | null = useWalletForVerify ? wallet.address : headlessSender;
  const verifyChain: number | null = useWalletForVerify ? wallet.chainId : headlessChainId;

  return (
    <Section
      id="ecdsa"
      title="ECDSA — Scheme 0x01 (EIP-712 over BAMMessage)"
      description="Headless: generateECDSAPrivateKey, signECDSAWithKey, verifyECDSA. Wallet: signECDSA against an injected viem WalletClient."
    >
      <Field label="app bytes (utf-8) — wrapped in tag-prefixed contents (shared by both paths)">
        <TextInput value={appText} onChange={(e) => setAppText(e.target.value)} />
      </Field>

      {/* ── Headless path ─────────────────────────────────────── */}
      <div className="border-l-2 border-blue-500 pl-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-blue-700 dark:text-blue-400 font-semibold">
          Headless (signECDSAWithKey)
        </div>

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
        <Field label="chainId (headless only — wallet path uses the connected chain)">
          <TextInput value={chainId} onChange={(e) => setChainId(e.target.value)} />
        </Field>
        <ErrorBox value={chainIdError} />

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!privateKey || headlessChainId === null}
            onClick={() =>
              digest.run(() =>
                computeECDSADigest(buildMessage(address as Address), headlessChainId!)
              )
            }
          >
            computeECDSADigest
          </Button>
          <Button
            disabled={!privateKey || headlessChainId === null}
            onClick={() =>
              sign.run(
                () => {
                  const sig = signECDSAWithKey(
                    privateKey as `0x${string}`,
                    buildMessage(address as Address),
                    headlessChainId!
                  );
                  updateSignature(sig, 'headless');
                  return sig;
                },
                (sig) => `${sig}  (${(sig.length - 2) / 2} bytes)`
              )
            }
          >
            signECDSAWithKey
          </Button>
        </div>

        <Output value={digest.output} label="EIP-712 digest" />
        <ErrorBox value={digest.error} />
        <Output value={sign.output} label="signECDSAWithKey" />
        <ErrorBox value={sign.error} />
      </div>

      {/* ── Wallet path ────────────────────────────────────────── */}
      <div className="border-l-2 border-emerald-500 pl-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-400 font-semibold">
          Wallet (signECDSA via viem WalletClient)
        </div>

        {!wallet.available && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No injected wallet detected. Install MetaMask / Rabby / similar to enable this
            path.
          </p>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          {wallet.client ? (
            <>
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                connected · {wallet.address?.slice(0, 6)}…{wallet.address?.slice(-4)} · chain{' '}
                {wallet.chainId}
              </span>
              <Button
                className="bg-neutral-600 hover:bg-neutral-700"
                onClick={() => wallet.disconnect()}
              >
                disconnect
              </Button>
            </>
          ) : (
            <Button
              disabled={!wallet.available}
              onClick={() => connect.run(() => wallet.connect())}
            >
              connect wallet
            </Button>
          )}
          <Button
            disabled={!wallet.client || !wallet.address}
            onClick={() =>
              walletSign.run(
                async () => {
                  const sig = await signECDSA(wallet.client!, buildMessage(wallet.address!));
                  updateSignature(sig, 'wallet');
                  return sig;
                },
                (sig) => `${sig}  (${(sig.length - 2) / 2} bytes)`
              )
            }
          >
            signECDSA (wallet)
          </Button>
        </div>
        <ErrorBox value={wallet.error || connect.error} />
        <Output value={walletSign.output} label="signECDSA (wallet)" />
        <ErrorBox value={walletSign.error} />
      </div>

      {/* ── Verify (works for either path) ────────────────────── */}
      <div className="border-l-2 border-neutral-400 pl-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-neutral-600 dark:text-neutral-400 font-semibold">
          verifyECDSA
        </div>
        <Field label="signature (65 bytes, r ‖ s ‖ v) — populated by either sign button">
          <TextInput
            value={signature}
            onChange={(e) => updateSignature(e.target.value, null)}
          />
        </Field>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Verifies against <code>{verifySender ?? '(no sender)'}</code> on chain{' '}
          {String(verifyChain ?? '?')}. Routing follows the path that produced the current
          signature ({signatureSource ?? 'manual / headless fallback'}); editing the box by
          hand falls back to the headless inputs.
        </p>
        <Button
          disabled={!signature || !verifySender || verifyChain == null}
          onClick={() =>
            verify.run(
              () =>
                verifyECDSA(
                  buildMessage(verifySender!),
                  signature as `0x${string}`,
                  verifySender!,
                  verifyChain!
                ),
              (ok) => (ok ? '✓ valid' : '✗ INVALID')
            )
          }
        >
          verifyECDSA
        </Button>
        <Output value={verify.output} label="verifyECDSA" />
        <ErrorBox value={verify.error} />
      </div>
    </Section>
  );
}
