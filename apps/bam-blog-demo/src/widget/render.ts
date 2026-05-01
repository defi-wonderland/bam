/**
 * Imperative DOM rendering for the comments widget. No
 * framework: each `render*` function takes a target element and
 * mutates it in place. The controller in `index.ts` calls into
 * these on every state change; rebuilds are cheap because the
 * comment counts are small.
 *
 * Per the spec's *Adversarial scenarios*, pending vs. confirmed
 * is visually distinguishable (a "pending" badge on pending
 * rows). Reply affordance is hidden at `displayDepth === 2`
 * (the depth-2 cap from `tasks.md` G-7 / acceptance gate).
 */

import type { Hex } from 'viem';

import type { CommentNode, PostThread } from './thread.js';
import { MAX_COMMENT_CHARS } from './content-tag.js';

export interface ComposerState {
  readonly busy: boolean;
  readonly draft: string;
  readonly errorText: string | null;
  /**
   * `null` for the top-level composer; bytes32 of the parent
   * messageHash for an in-thread reply form.
   */
  readonly replyTo: Hex | null;
}

export interface RenderState {
  readonly connected: Hex | null;
  readonly thread: PostThread | null;
  /** True when at least one fetch has completed (success or fail). */
  readonly loaded: boolean;
  readonly loadError: boolean;
  readonly composer: ComposerState;
}

export interface RenderHandlers {
  readonly onConnectClick: () => void;
  readonly onDraftChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onCancelReply: () => void;
  readonly onStartReply: (parentMessageHash: Hex) => void;
}

const NBSP = ' ';

/**
 * Renders the entire widget into `mount`. Idempotent: every
 * render call recreates the inside of `mount` from `state`.
 */
export function render(
  mount: HTMLElement,
  state: RenderState,
  handlers: RenderHandlers
): void {
  // Capture textarea focus + caret before the rebuild — the
  // controller re-renders on every keystroke, and without this the
  // composer would lose focus mid-typing.
  const active = document.activeElement;
  const restore =
    active instanceof HTMLTextAreaElement && mount.contains(active)
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;

  mount.replaceChildren();
  mount.appendChild(renderConnect(state, handlers));
  if (state.composer.replyTo === null) {
    mount.appendChild(renderComposer(state, handlers));
  }
  mount.appendChild(renderThread(state, handlers));

  if (restore !== null) {
    const ta = mount.querySelector<HTMLTextAreaElement>(
      '.bam-composer textarea'
    );
    if (ta !== null && !ta.disabled) {
      ta.focus();
      try {
        ta.setSelectionRange(restore.start, restore.end);
      } catch {
        // selectionStart/End can be null on some browsers
      }
    }
  }
}

function renderConnect(
  state: RenderState,
  handlers: RenderHandlers
): HTMLElement {
  const wrap = el('div', 'bam-connect');
  if (state.connected === null) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Connect wallet to comment';
    btn.addEventListener('click', handlers.onConnectClick);
    wrap.appendChild(btn);
  } else {
    wrap.append(
      `Signed in as${NBSP}`,
      mono(shortAddress(state.connected))
    );
  }
  return wrap;
}

function renderComposer(
  state: RenderState,
  handlers: RenderHandlers
): HTMLElement {
  const form = el('div', 'bam-composer');

  const ta = document.createElement('textarea');
  ta.placeholder =
    state.composer.replyTo === null
      ? 'Add a comment'
      : 'Write your reply';
  ta.value = state.composer.draft;
  ta.disabled = state.composer.busy || state.connected === null;
  ta.maxLength = MAX_COMMENT_CHARS * 4;
  ta.addEventListener('input', (e) => {
    handlers.onDraftChange((e.currentTarget as HTMLTextAreaElement).value);
  });
  form.appendChild(ta);

  const row = el('div', 'bam-composer__row');

  const remaining = MAX_COMMENT_CHARS - [...state.composer.draft].length;
  const charsClass =
    remaining < 0
      ? 'bam-composer__chars bam-composer__chars--bad'
      : remaining < 30
        ? 'bam-composer__chars bam-composer__chars--warn'
        : 'bam-composer__chars';
  const chars = el('span', charsClass);
  chars.textContent = String(remaining);
  row.appendChild(chars);

  const buttons = el('span', '');

  if (state.composer.replyTo !== null) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', handlers.onCancelReply);
    buttons.appendChild(cancel);
    buttons.append(NBSP);
  }

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = state.composer.busy
    ? state.composer.replyTo !== null
      ? 'Replying…'
      : 'Posting…'
    : state.composer.replyTo !== null
      ? 'Reply'
      : 'Post';
  submit.disabled =
    state.connected === null ||
    state.composer.busy ||
    state.composer.draft.trim() === '' ||
    remaining < 0;
  submit.addEventListener('click', handlers.onSubmit);
  buttons.appendChild(submit);

  row.appendChild(buttons);
  form.appendChild(row);

  if (state.composer.errorText !== null) {
    const err = el('div', 'bam-composer__error');
    err.textContent = state.composer.errorText;
    form.appendChild(err);
  }

  return form;
}

function renderThread(
  state: RenderState,
  handlers: RenderHandlers
): HTMLElement {
  if (state.loadError && (state.thread === null || state.thread.roots.length === 0)) {
    return statusLine(
      'Couldn’t load comments. The comment indexer may be unavailable.',
      'bam-status--error'
    );
  }
  if (!state.loaded) {
    return statusLine('Loading comments…');
  }
  if (state.thread === null || state.thread.roots.length === 0) {
    return statusLine('No comments yet — be the first.');
  }
  return renderNodeList(state.thread.roots, state, handlers);
}

function renderNodeList(
  nodes: readonly CommentNode[],
  state: RenderState,
  handlers: RenderHandlers
): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = 'bam-thread';
  for (const n of nodes) {
    ul.appendChild(renderNode(n, state, handlers));
  }
  return ul;
}

function renderNode(
  node: CommentNode,
  state: RenderState,
  handlers: RenderHandlers
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'bam-comment';
  li.dataset.depth = String(node.displayDepth);
  li.dataset.messageHash = node.message.messageHash;

  const head = el('div', 'bam-comment__head');
  head.appendChild(mono(shortAddress(node.message.author)));
  head.append(`${NBSP}·${NBSP}`);
  head.append(formatTimestamp(node.message.timestamp));
  if (node.message.status === 'pending') {
    head.append(NBSP);
    const badge = el('span', 'bam-comment__badge--pending');
    badge.textContent = 'pending';
    head.appendChild(badge);
  }
  li.appendChild(head);

  const body = el('p', 'bam-comment__body');
  body.textContent = node.message.content;
  li.appendChild(body);

  // Reply affordance: shown only when connected, only on
  // confirmed comments (replying to something not yet on-chain
  // would orphan if the parent never confirms), and only at
  // displayDepth < 2 per the depth cap.
  const canReply =
    state.connected !== null &&
    node.message.status === 'confirmed' &&
    node.displayDepth < 2;
  if (canReply) {
    const actions = el('div', 'bam-comment__actions');
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'bam-comment__reply-btn';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', () =>
      handlers.onStartReply(node.message.messageHash)
    );
    actions.appendChild(replyBtn);
    li.appendChild(actions);
  }

  // Inline reply form: appears under the comment whose
  // messageHash matches `composer.replyTo`.
  if (
    state.composer.replyTo !== null &&
    state.composer.replyTo.toLowerCase() ===
      node.message.messageHash.toLowerCase()
  ) {
    li.appendChild(renderComposer(state, handlers));
  }

  if (node.children.length > 0) {
    li.appendChild(renderNodeList(node.children, state, handlers));
  }
  return li;
}

function statusLine(text: string, extraClass = ''): HTMLElement {
  const cls = extraClass ? `bam-status ${extraClass}` : 'bam-status';
  const p = el('p', cls);
  p.textContent = text;
  return p;
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className.length > 0) node.className = className;
  return node;
}

function mono(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'bam-comment__addr';
  span.textContent = text;
  return span;
}

function shortAddress(addr: Hex): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTimestamp(unixSeconds: number): string {
  const ms = unixSeconds * 1000;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  // ISO-ish but compact: "2024-10-14 12:34"
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
