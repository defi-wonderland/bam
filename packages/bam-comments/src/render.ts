/**
 * Imperative DOM renderer for one mounted comments instance. Drives a
 * tiny state machine — `idle` (showing thread) ↔ `composing` (focus
 * on textarea) ↔ `submitting` (button disabled) — and re-renders the
 * whole tree on state changes. Composer focus + caret are preserved
 * across re-renders by snapshotting `selectionStart`/`selectionEnd`.
 *
 * Wallet, codec, post-id, and upstream HTTP live in sibling modules;
 * this file is the glue.
 */

import { BAM_COMMENTS_TAG } from './content-tag.js';
import { encodeCommentContents, type CommentEnvelope } from './codec.js';
import { resolveSiteId, derivePostIdHash } from './post-id.js';
import { buildThread, type DecodedMessage, type CommentNode } from './thread.js';
import {
  ensureSepolia,
  getProvider,
  onAccountsChanged,
  requestAccount,
  requireProvider,
  signTypedData,
  SEPOLIA_CHAIN_ID,
  WalletError,
} from './eth.js';
import { buildTypedData } from './typed-data.js';
import {
  getNextNonce,
  listForPost,
  submitMessage,
  UpstreamError,
} from './poster-reader.js';

const POLL_INTERVAL_MS = 5_000;
const MAX_STALE_NONCE_RETRIES = 8;
const COMMENT_MAX_CHARS = 4_000;

interface MountState {
  postIdHash: `0x${string}`;
  account: `0x${string}` | null;
  messages: DecodedMessage[];
  composing: { parent?: `0x${string}`; draft: string } | null;
  submitting: boolean;
  error: string | null;
  loading: boolean;
}

/**
 * Public API: mount the widget on `target`. Idempotent — a second
 * call on the same node is a no-op. Returns a destroy callback the
 * embedder may invoke to tear the instance down (the auto-mount
 * snippet doesn't, but tests do).
 */
export function mountInstance(target: HTMLElement): () => void {
  if ((target as HTMLElement & { __bamMounted?: boolean }).__bamMounted) {
    return () => {};
  }
  (target as HTMLElement & { __bamMounted?: boolean }).__bamMounted = true;

  const postId = target.getAttribute('data-post-id');
  if (postId === null || postId === '') {
    target.textContent = 'bam-comments: data-post-id missing';
    return () => {};
  }
  const siteId = resolveSiteId(
    target.getAttribute('data-site-id'),
    typeof window === 'undefined' ? '' : window.location.hostname
  );
  const postIdHash = derivePostIdHash(BAM_COMMENTS_TAG, siteId, postId);

  const state: MountState = {
    postIdHash,
    account: null,
    messages: [],
    composing: null,
    submitting: false,
    error: null,
    loading: true,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupAccountsChanged: (() => void) | null = null;
  let destroyed = false;

  const refresh = async () => {
    if (destroyed) return;
    try {
      const messages = await listForPost({
        contentTag: BAM_COMMENTS_TAG,
        postIdHash,
        limit: 1000,
      });
      if (destroyed) return;
      state.messages = messages;
      state.loading = false;
      render();
    } catch (err) {
      if (destroyed) return;
      state.loading = false;
      state.error = err instanceof Error ? err.message : 'failed to load comments';
      render();
    }
  };

  const render = () => {
    if (destroyed) return;
    renderInto(target, state, {
      onConnect,
      onStartCompose: (parent) => {
        state.composing = { parent, draft: state.composing?.draft ?? '' };
        state.error = null;
        render();
      },
      onCancelCompose: () => {
        state.composing = null;
        render();
      },
      onDraftChange: (draft) => {
        if (state.composing !== null) state.composing.draft = draft;
      },
      onSubmit,
    });
  };

  async function onConnect() {
    state.error = null;
    try {
      const provider = requireProvider();
      const account = await requestAccount(provider);
      await ensureSepolia(provider);
      state.account = account;
      cleanupAccountsChanged = onAccountsChanged(provider, (accs) => {
        state.account = (accs[0]?.toLowerCase() ?? null) as `0x${string}` | null;
        render();
      });
      render();
    } catch (err) {
      state.error = describeError(err);
      render();
    }
  }

  async function onSubmit() {
    if (state.composing === null || state.submitting) return;
    const draft = state.composing.draft.trim();
    if (draft.length === 0) return;
    if (draft.length > COMMENT_MAX_CHARS) {
      state.error = `comment too long (max ${COMMENT_MAX_CHARS} chars)`;
      render();
      return;
    }
    state.submitting = true;
    state.error = null;
    render();
    try {
      const provider = requireProvider();
      let account = state.account;
      if (account === null) {
        account = await requestAccount(provider);
        state.account = account;
      }
      await ensureSepolia(provider);
      await submitOnce(account, draft, state.composing.parent);
      // Optimistic clear; the next poll picks up the pending row.
      state.composing = null;
      state.submitting = false;
      render();
      void refresh();
    } catch (err) {
      state.submitting = false;
      state.error = describeError(err);
      render();
    }
  }

  async function submitOnce(
    account: `0x${string}`,
    draft: string,
    parent: `0x${string}` | undefined
  ): Promise<void> {
    let nonce = await getNextNonce(account);
    for (let attempt = 0; attempt <= MAX_STALE_NONCE_RETRIES; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);
      const envelope: CommentEnvelope =
        parent !== undefined
          ? {
              kind: 'reply',
              postIdHash,
              timestamp,
              parentMessageHash: parent,
              content: draft,
            }
          : { kind: 'comment', postIdHash, timestamp, content: draft };
      const contents = encodeCommentContents(BAM_COMMENTS_TAG, envelope);
      const provider = requireProvider();
      const td = buildTypedData({
        sender: account,
        nonce,
        contents,
        chainId: SEPOLIA_CHAIN_ID,
      });
      const signature = await signTypedData(provider, account, td);
      const result = await submitMessage({
        contentTag: BAM_COMMENTS_TAG,
        sender: account,
        nonce,
        contents,
        signature,
      });
      if (result.ok) return;
      if (result.reason !== 'stale_nonce' || attempt === MAX_STALE_NONCE_RETRIES) {
        throw new Error(result.reason);
      }
      nonce = await getNextNonce(account);
    }
  }

  // Initial provider check: surface a passive prompt to connect, but
  // don't auto-prompt — clicking the connect button is the user's
  // explicit consent.
  const provider = getProvider();
  if (provider !== null) {
    // Best-effort: if the wallet remembers an authorisation, surface
    // the connected account immediately so the composer is enabled.
    void provider
      .request({ method: 'eth_accounts' })
      .then((accs) => {
        if (Array.isArray(accs) && accs.length > 0) {
          state.account = (accs[0] as string).toLowerCase() as `0x${string}`;
          render();
        }
      })
      .catch(() => {
        /* no-op: not authorised yet */
      });
  }

  void refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  render();

  return () => {
    destroyed = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    cleanupAccountsChanged?.();
    target.replaceChildren();
    (target as HTMLElement & { __bamMounted?: boolean }).__bamMounted = false;
  };
}

interface RenderHooks {
  onConnect: () => void;
  onStartCompose: (parent?: `0x${string}`) => void;
  onCancelCompose: () => void;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
}

function renderInto(
  target: HTMLElement,
  state: MountState,
  hooks: RenderHooks
): void {
  // Snapshot composer focus + caret so a full re-render doesn't
  // yank the cursor out from under a typing user.
  const prev = target.querySelector<HTMLTextAreaElement>('.bam-textarea');
  const focusSnapshot =
    prev !== null && document.activeElement === prev
      ? {
          start: prev.selectionStart ?? 0,
          end: prev.selectionEnd ?? 0,
        }
      : null;

  target.replaceChildren(
    headerEl(state, hooks),
    composerEl(state, hooks),
    threadEl(state, hooks)
  );

  if (focusSnapshot !== null) {
    const next = target.querySelector<HTMLTextAreaElement>('.bam-textarea');
    if (next !== null) {
      next.focus();
      try {
        next.setSelectionRange(focusSnapshot.start, focusSnapshot.end);
      } catch {
        /* some browsers throw on detached nodes; ignore */
      }
    }
  }
}

function headerEl(state: MountState, hooks: RenderHooks): HTMLElement {
  const head = document.createElement('div');
  head.className = 'bam-header';

  const title = document.createElement('h3');
  title.className = 'bam-title';
  title.textContent = 'Comments';
  head.appendChild(title);

  if (state.account !== null) {
    const acc = document.createElement('span');
    acc.className = 'bam-account';
    acc.textContent = shortAddress(state.account);
    acc.title = state.account;
    head.appendChild(acc);
  } else {
    const btn = button('Connect wallet', false, hooks.onConnect);
    head.appendChild(btn);
  }

  return head;
}

function composerEl(state: MountState, hooks: RenderHooks): HTMLElement {
  if (state.account === null) {
    const note = document.createElement('div');
    note.className = 'bam-empty';
    note.textContent = 'Connect a wallet to leave a comment.';
    return note;
  }

  if (state.composing === null && state.error !== null) {
    const wrap = document.createElement('div');
    wrap.appendChild(emptyComposer(hooks));
    const err = document.createElement('div');
    err.className = 'bam-error';
    err.textContent = state.error;
    wrap.appendChild(err);
    return wrap;
  }

  if (state.composing === null) {
    return emptyComposer(hooks);
  }

  const wrap = document.createElement('div');
  wrap.className = 'bam-composer';

  const ta = document.createElement('textarea');
  ta.className = 'bam-textarea';
  ta.placeholder =
    state.composing.parent !== undefined
      ? 'Write a reply…'
      : 'Write a comment…';
  ta.value = state.composing.draft;
  ta.disabled = state.submitting;
  ta.maxLength = COMMENT_MAX_CHARS;
  ta.addEventListener('input', () => hooks.onDraftChange(ta.value));
  wrap.appendChild(ta);

  const bar = document.createElement('div');
  bar.className = 'bam-composer-bar';

  const cancel = button('Cancel', state.submitting, hooks.onCancelCompose);
  cancel.classList.add('bam-secondary');
  bar.appendChild(cancel);

  const submitLabel = state.submitting ? 'Submitting…' : 'Submit';
  const submit = button(
    submitLabel,
    state.submitting || state.composing.draft.trim().length === 0,
    hooks.onSubmit
  );
  bar.appendChild(submit);
  wrap.appendChild(bar);

  if (state.error !== null) {
    const err = document.createElement('div');
    err.className = 'bam-error';
    err.textContent = state.error;
    wrap.appendChild(err);
  }
  return wrap;
}

function emptyComposer(hooks: RenderHooks): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bam-composer';
  const trigger = button('Leave a comment', false, () => hooks.onStartCompose());
  trigger.classList.add('bam-secondary');
  wrap.appendChild(trigger);
  return wrap;
}

function threadEl(state: MountState, hooks: RenderHooks): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bam-thread';
  if (state.loading) {
    const loading = document.createElement('div');
    loading.className = 'bam-loading';
    loading.textContent = 'Loading…';
    wrap.appendChild(loading);
    return wrap;
  }
  const { roots } = buildThread(state.messages);
  if (roots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bam-empty';
    empty.textContent = 'No comments yet — be the first.';
    wrap.appendChild(empty);
    return wrap;
  }
  for (const root of roots) {
    wrap.appendChild(commentEl(root, state, hooks));
  }
  return wrap;
}

function commentEl(
  node: CommentNode,
  state: MountState,
  hooks: RenderHooks
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `bam-comment bam-depth-${node.displayDepth}`;
  wrap.setAttribute('data-message-hash', node.messageHash);

  const head = document.createElement('div');
  head.className = 'bam-comment-head';

  const author = document.createElement('span');
  author.className = 'bam-author';
  author.textContent = shortAddress(node.sender);
  author.title = node.sender;
  head.appendChild(author);

  const time = document.createElement('time');
  time.dateTime = new Date(node.timestamp * 1000).toISOString();
  time.textContent = formatRelativeTime(node.timestamp);
  head.appendChild(time);

  if (node.pending) {
    const pending = document.createElement('span');
    pending.className = 'bam-pending';
    pending.textContent = 'pending';
    head.appendChild(pending);
  }
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'bam-body';
  body.textContent = node.content;
  wrap.appendChild(body);

  // Reply affordance hidden when displayDepth would clamp to 2.
  if (node.displayDepth < 2 && state.account !== null) {
    const actions = document.createElement('div');
    actions.className = 'bam-comment-actions';
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'bam-reply-btn';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', () => hooks.onStartCompose(node.messageHash));
    actions.appendChild(replyBtn);
    wrap.appendChild(actions);
  }

  if (node.children.length > 0) {
    const children = document.createElement('div');
    children.className = 'bam-children';
    for (const c of node.children) {
      children.appendChild(commentEl(c, state, hooks));
    }
    wrap.appendChild(children);
  }
  return wrap;
}

function button(
  label: string,
  disabled: boolean,
  onClick: () => void
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bam-button';
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatRelativeTime(unixSeconds: number): string {
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function describeError(err: unknown): string {
  if (err instanceof WalletError) {
    switch (err.code) {
      case 'wallet_not_installed':
        return 'No Ethereum wallet detected. Install MetaMask or a compatible extension.';
      case 'request_rejected':
        return 'Request rejected in wallet.';
      case 'unsupported_method':
        return 'Wallet does not support typed-data signing.';
      case 'disconnected':
        return 'Wallet is disconnected.';
      case 'wrong_chain':
        return 'Switch your wallet to Sepolia and retry.';
      case 'bad_signature_shape':
        return 'Wallet returned a malformed signature.';
      default:
        return 'Wallet error.';
    }
  }
  if (err instanceof UpstreamError) {
    return err.kind === 'http'
      ? `Upstream error (${err.status ?? '?'})`
      : err.kind === 'network'
      ? 'Could not reach BAM upstreams.'
      : 'Unexpected upstream response.';
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
