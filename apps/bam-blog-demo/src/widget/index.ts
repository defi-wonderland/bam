/**
 * Widget entrypoint. Bundled by Vite into `dist/comments.js` and
 * loaded by every post page via:
 *
 *   <div id="comments" data-post-slug="<slug>"></div>
 *   <script type="module" src="/comments.js"></script>
 *
 * Lifecycle, in order:
 *
 *   1. Find `#comments[data-post-slug]`. Bail if missing or the
 *      slug is not in `KNOWN_POST_IDS` (silent — same posture as
 *      the thread builder dropping unknown post ids).
 *   2. Render the connect button + an empty thread placeholder
 *      while the first poll runs.
 *   3. Poll `/api/messages` (pending) and
 *      `/api/confirmed-messages` (confirmed) on a fixed interval,
 *      decode each row's `contents` via the codec, drop ones
 *      whose `postIdHash` doesn't match this post, hand the rest
 *      to `buildThreads`, and re-render.
 *   4. On submit: estimate next-nonce, encode + sign + submit; on
 *      `stale_nonce`, re-fetch and retry up to a small bound; on
 *      anything else, surface an error and ask the user to
 *      retry — the signed message is **not** retained.
 *
 * No React, no wagmi, no React Query. Just a setInterval and a
 * full re-render on every state change.
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
} from './eth.js';
import { slugToPostIdHash, postIdHashToSlug } from './post-id.js';
import {
  fetchConfirmed,
  fetchNextNonce,
  fetchPending,
  flushBatch,
  submitMessage,
} from './poster-reader.js';
import { buildThreads, type DecodedMessage } from './thread.js';
import { buildBamTypedData } from './typed-data.js';
import { render, type ComposerState, type RenderState } from './render.js';

const POLL_INTERVAL_MS = 5000;
const MAX_STALE_NONCE_RETRIES = 8;

interface Controller {
  state: RenderState;
  postIdHash: Hex;
  slug: string;
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
    const text = err instanceof WalletError
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
      decoded.push(dm);
    }
    const threads = buildThreads(decoded);
    c.state = {
      ...c.state,
      thread: threads.get(c.slug) ?? null,
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
    let chainId = SEPOLIA_CHAIN_ID;
    try {
      chainId = await getChainId();
    } catch {
      // Fall through with default; signing will surface the real error.
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
        // Best-effort: nudge the Poster's flush loop, then refresh.
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

async function bootstrap(): Promise<void> {
  const mount = document.getElementById('comments');
  if (mount === null) return;
  const slug = mount.getAttribute('data-post-slug');
  if (slug === null) return;
  const postIdHash = slugToPostIdHash(slug);
  if (postIdHashToSlug(postIdHash) === null) {
    // Should be impossible because slugToPostIdHash succeeded, but
    // belt-and-suspenders against build-time slug drift.
    return;
  }

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
    postIdHash,
    slug,
    mount,
  };

  // Best-effort initial connection state — does not prompt.
  try {
    const existing = await getConnectedAddress();
    if (existing !== null) {
      c.state = { ...c.state, connected: existing };
    }
  } catch {
    // Wallet not present or restrictive; render with no connection.
  }

  rerender(c);
  onAccountsChanged((next) => {
    c.state = { ...c.state, connected: next };
    rerender(c);
  });

  await poll(c);
  setInterval(() => void poll(c), POLL_INTERVAL_MS);
}

void bootstrap();
