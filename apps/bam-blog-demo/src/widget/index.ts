/**
 * Embeddable BAM comments widget. Snippet for a host page:
 *
 *   <div data-bam-comments data-post-id="my-post-slug"></div>
 *   <script src="https://<host>/widget.js" defer></script>
 *
 * Auto-mounts on every `[data-bam-comments]` element on the page;
 * the same script can drive multiple comment threads on one page
 * (e.g., a list of articles each with its own thread).
 *
 * The host's `data-post-id` is hashed
 * (`keccak256("bam-blog.v1:" + postId)`) to derive the per-post
 * scoping that rides inside the signed `contents` payload. Hosts
 * can use any string they like for the post id; collisions
 * happen only if two embedders share a slug, which keccak makes
 * effectively zero-risk.
 *
 * The widget bakes its upstream Poster + Reader URLs in at build
 * time via `VITE_POSTER_URL` / `VITE_READER_URL`. Browser calls
 * upstreams directly — they must allow CORS.
 *
 * Styles ship inline (`widget.css` imported as a string and
 * injected once into `<head>`), so a host doesn't need to load
 * any extra stylesheet.
 */

import type { Hex } from 'viem';

import { decodeBlogContents, encodeBlogContents, type BlogMessage } from './codec.js';
import {
  BLOG_DEMO_CONTENT_TAG,
  MAX_COMMENT_CHARS,
  SEPOLIA_CHAIN_ID,
} from './content-tag.js';
import {
  WalletError,
  connect as walletConnect,
  getConnectedAddress,
  getChainId,
  onAccountsChanged,
  signTypedData as walletSignTypedData,
  switchChain as walletSwitchChain,
} from './eth.js';
import { derivePostIdHash, resolveSiteId } from './post-id.js';
import {
  fetchConfirmed,
  fetchNextNonce,
  fetchPending,
  flushBatch,
  submitMessage,
} from './poster-reader.js';
import { buildThread, type DecodedMessage } from './thread.js';
import { buildBamTypedData } from './typed-data.js';
import { render, type ComposerState, type RenderState } from './render.js';
import widgetCss from './widget.css?inline';

const POLL_INTERVAL_MS = 5000;
const MAX_STALE_NONCE_RETRIES = 8;

interface Controller {
  state: RenderState;
  siteId: string;
  postId: string;
  postIdHash: Hex;
  mount: HTMLElement;
}

function rerender(c: Controller): void {
  render(c.mount, c.state, {
    onConnectClick: () => {
      void connectWallet(c);
    },
    onDraftChange: (next) => {
      c.state = withComposer(c.state, { draft: next });
      rerender(c);
    },
    onSubmit: () => {
      void submit(c);
    },
    onCancelReply: () => {
      c.state = withComposer(c.state, {
        replyTo: null,
        draft: '',
        errorText: null,
      });
      rerender(c);
    },
    onStartReply: (parent) => {
      c.state = withComposer(c.state, {
        replyTo: parent,
        draft: '',
        errorText: null,
      });
      rerender(c);
    },
  });
}

function withComposer(
  state: RenderState,
  patch: Partial<ComposerState>
): RenderState {
  return { ...state, composer: { ...state.composer, ...patch } };
}

async function connectWallet(c: Controller): Promise<void> {
  try {
    const addr = await walletConnect();
    c.state = { ...c.state, connected: addr };
    rerender(c);
  } catch (err) {
    const text =
      err instanceof WalletError
        ? walletErrorText(err)
        : 'Could not connect wallet.';
    c.state = withComposer(c.state, { errorText: text });
    rerender(c);
  }
}

function walletErrorText(err: WalletError): string {
  switch (err.code) {
    case 'wallet_not_installed':
      return 'No Ethereum wallet detected. Install one to comment.';
    case 'request_rejected':
      return 'Request was rejected in the wallet.';
    case 'unsupported_method':
      return 'This wallet does not support EIP-712 typed data signing.';
    case 'disconnected':
      return 'Wallet is disconnected. Reconnect and try again.';
    case 'bad_signature_shape':
      return 'Wallet returned an invalid signature.';
    case 'wrong_chain':
      return 'Please switch your wallet to Sepolia and try again.';
    default:
      return 'Wallet error.';
  }
}

async function poll(c: Controller): Promise<void> {
  try {
    const [pendingRaw, confirmedRaw] = await Promise.all([
      fetchPending(),
      fetchConfirmed(),
    ]);
    const decoded: DecodedMessage[] = [];
    const seenHashes = new Set<string>();
    const wantHash = c.postIdHash.toLowerCase();
    // Confirmed first; on duplicate hash, prefer confirmed.
    for (const r of confirmedRaw) {
      const dm = toDecoded(
        r.contents,
        r.messageHash,
        r.author,
        r.nonce,
        'confirmed'
      );
      if (dm === null) continue;
      if (dm.postIdHash.toLowerCase() !== wantHash) continue;
      seenHashes.add(dm.messageHash.toLowerCase());
      decoded.push(dm);
    }
    for (const p of pendingRaw) {
      if (seenHashes.has(p.messageHash.toLowerCase())) continue;
      const dm = toDecoded(
        p.contents,
        p.messageHash,
        p.sender,
        p.nonce,
        'pending'
      );
      if (dm === null) continue;
      if (dm.postIdHash.toLowerCase() !== wantHash) continue;
      decoded.push(dm);
    }
    const thread = buildThread(decoded);
    c.state = {
      ...c.state,
      thread: thread.roots.length > 0 ? thread : null,
      loaded: true,
      loadError: false,
    };
    rerender(c);
  } catch {
    c.state = { ...c.state, loaded: true, loadError: true };
    rerender(c);
  }
}

function toDecoded(
  contentsHex: Hex | string,
  messageHash: Hex | string,
  sender: Hex | string,
  nonce: string,
  status: 'pending' | 'confirmed'
): DecodedMessage | null {
  try {
    const { app } = decodeBlogContents(hexToBytes(contentsHex));
    if (app.kind === 'comment') {
      return {
        messageHash: messageHash as Hex,
        postIdHash: app.postIdHash,
        timestamp: app.timestamp,
        content: app.content,
        author: sender as Hex,
        kind: 'comment',
        status,
      };
    }
    return {
      messageHash: messageHash as Hex,
      postIdHash: app.postIdHash,
      timestamp: app.timestamp,
      content: app.content,
      author: sender as Hex,
      kind: 'reply',
      parentMessageHash: app.parentMessageHash,
      status,
    };
  } catch {
    void nonce; // intentionally unused — kept on the boundary for future use
    return null;
  }
}

async function submit(c: Controller): Promise<void> {
  const sender = c.state.connected;
  if (sender === null) return;
  if (c.state.composer.busy) return;
  const draft = c.state.composer.draft.trim();
  if (draft === '') return;
  if ([...draft].length > MAX_COMMENT_CHARS) return;

  c.state = withComposer(c.state, { busy: true, errorText: null });
  rerender(c);

  try {
    let chainId: number;
    try {
      chainId = await getChainId();
    } catch {
      chainId = SEPOLIA_CHAIN_ID;
    }
    if (chainId !== SEPOLIA_CHAIN_ID) {
      await walletSwitchChain(SEPOLIA_CHAIN_ID);
      chainId = await getChainId();
      if (chainId !== SEPOLIA_CHAIN_ID) {
        throw new WalletError(
          'wrong_chain',
          `wallet is on chain ${chainId}; expected ${SEPOLIA_CHAIN_ID}`
        );
      }
    }

    let nonce = await fetchNextNonce(sender);
    let attempt = 0;

    while (attempt <= MAX_STALE_NONCE_RETRIES) {
      const timestamp = Math.floor(Date.now() / 1000);
      const replyTo = c.state.composer.replyTo;
      const app: BlogMessage =
        replyTo !== null
          ? {
              kind: 'reply',
              postIdHash: c.postIdHash,
              timestamp,
              parentMessageHash: replyTo,
              content: draft,
            }
          : {
              kind: 'comment',
              postIdHash: c.postIdHash,
              timestamp,
              content: draft,
            };
      const contents = encodeBlogContents(BLOG_DEMO_CONTENT_TAG, app);
      const contentsHex = bytesToHex(contents);
      const typedData = buildBamTypedData({
        sender,
        nonce,
        contents: contentsHex,
        chainId,
      });
      const signature = await walletSignTypedData({
        address: sender,
        typedData,
      });
      const result = await submitMessage({
        contentTag: BLOG_DEMO_CONTENT_TAG,
        sender,
        nonce,
        contents: contentsHex,
        signature,
      });
      if (result.accepted) {
        c.state = withComposer(c.state, {
          busy: false,
          draft: '',
          errorText: null,
          replyTo: null,
        });
        rerender(c);
        void flushBatch();
        await poll(c);
        return;
      }
      if (result.reason === 'stale_nonce' && attempt < MAX_STALE_NONCE_RETRIES) {
        attempt += 1;
        nonce = await fetchNextNonce(sender);
        continue;
      }
      throw new SubmitError(result.reason ?? 'submission_failed');
    }
    throw new SubmitError('stale_nonce_retries_exhausted');
  } catch (err) {
    const text =
      err instanceof WalletError
        ? walletErrorText(err)
        : err instanceof SubmitError
          ? `Comment was not accepted (${err.reason}). Please retry.`
          : 'Comment failed to submit. Please retry.';
    c.state = withComposer(c.state, { busy: false, errorText: text });
    rerender(c);
  }
}

class SubmitError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): Hex {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as Hex;
}

/**
 * Inject the widget's stylesheet into the host document the
 * first time any instance mounts. Idempotent — repeat calls
 * are no-ops.
 */
let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-bam-comments-css', '');
  style.textContent = widgetCss;
  document.head.appendChild(style);
  cssInjected = true;
}

async function bootstrapOne(mount: HTMLElement, postId: string): Promise<void> {
  // Idempotent: refuse to mount twice on the same node.
  if (mount.dataset.bamMounted === '1') return;
  mount.dataset.bamMounted = '1';

  // siteId is the explicit `data-site-id` attribute if present,
  // else `window.location.hostname`. The pair (siteId, postId)
  // determines the post-id hash, so two different sites with the
  // same `data-post-id="my-post"` see independent threads.
  const siteId = resolveSiteId(mount);
  const postIdHash = derivePostIdHash({ siteId, postId });

  const c: Controller = {
    state: {
      connected: null,
      thread: null,
      loaded: false,
      loadError: false,
      composer: {
        busy: false,
        draft: '',
        errorText: null,
        replyTo: null,
      },
    },
    siteId,
    postId,
    postIdHash,
    mount,
  };

  // Best-effort initial connection state — does not prompt.
  try {
    const existing = await getConnectedAddress();
    if (existing !== null) {
      c.state = { ...c.state, connected: existing };
    }
  } catch {
    // Wallet not present or restrictive.
  }

  rerender(c);
  onAccountsChanged((next) => {
    c.state = { ...c.state, connected: next };
    rerender(c);
  });

  await poll(c);
  setInterval(() => void poll(c), POLL_INTERVAL_MS);
}

function bootstrapAll(): void {
  injectCss();
  const mounts = document.querySelectorAll<HTMLElement>('[data-bam-comments]');
  for (const m of mounts) {
    const postId = m.getAttribute('data-post-id');
    if (postId === null || postId === '') continue;
    void bootstrapOne(m, postId);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapAll);
} else {
  bootstrapAll();
}
