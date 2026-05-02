/**
 * Thread builder. Takes a flat list of decoded messages — already
 * filtered to a single post by the caller — and returns a tree
 * clamped at two levels of visual nesting.
 *
 * Rules:
 *
 *   1. Within the input bucket, a reply is followed up its parent
 *      chain (`parentMessageHash` lookups). If the chain hits a
 *      missing message, the reply is hidden (orphan). If a cycle
 *      is detected, every node on the cycle is dropped (data is
 *      adversarial or corrupted).
 *
 *   2. The tree preserves the true (unclamped) parent-child
 *      structure, but each node carries a `displayDepth` of
 *      `min(actualDepth, 2)` so the renderer indents at most two
 *      levels regardless of how deep the wire-level chain goes.
 *
 *   3. Children and roots are sorted by
 *      `(timestamp asc, messageHash asc)` for stable ordering.
 *
 * The widget filters by the mounted `postIdHash` upstream of this
 * function so the builder doesn't need to know about the demo's
 * post set — it works for any post id.
 */

import type { Hex } from 'viem';

export interface DecodedMessage {
  /** ERC-8180 messageHash, used as the unique id. */
  readonly messageHash: Hex;
  /** Per-post identifier carried in the signed payload. */
  readonly postIdHash: Hex;
  readonly timestamp: number;
  readonly content: string;
  readonly author: Hex;
  readonly kind: 'comment' | 'reply';
  /** Defined only for `reply`. */
  readonly parentMessageHash?: Hex;
  readonly status: 'pending' | 'confirmed';
}

export interface CommentNode {
  readonly message: DecodedMessage;
  /** Clamped to {0, 1, 2}; the wire-level depth may exceed 2. */
  readonly displayDepth: 0 | 1 | 2;
  readonly children: CommentNode[];
}

/** Thin alias so consumers (renderer, controller) can treat the
 *  return shape as a named type. */
export interface PostThread {
  readonly roots: CommentNode[];
}

const MAX_DISPLAY_DEPTH = 2;

/**
 * Build a single thread tree from a flat list of messages already
 * scoped to one post.
 */
export function buildThread(
  messages: readonly DecodedMessage[]
): PostThread {
  // messageHash → message lookup (lowercased keys).
  const byHash = new Map<string, DecodedMessage>();
  for (const m of messages) {
    byHash.set(m.messageHash.toLowerCase(), m);
  }

  // Classify every message: kept with a depth, or dropped (orphan / cycle).
  type Classification = { kept: true; depth: number } | { kept: false };
  const classified = new Map<string, Classification>();
  for (const m of messages) {
    classified.set(m.messageHash.toLowerCase(), classify(m, byHash));
  }

  // Materialize nodes for kept messages.
  const nodes = new Map<string, CommentNode>();
  for (const [hash, c] of classified) {
    if (!c.kept) continue;
    const m = byHash.get(hash)!;
    const node: CommentNode = {
      message: m,
      displayDepth: Math.min(c.depth, MAX_DISPLAY_DEPTH) as 0 | 1 | 2,
      children: [],
    };
    nodes.set(hash, node);
  }

  // Wire children to their parents.
  const roots: CommentNode[] = [];
  for (const [hash, c] of classified) {
    if (!c.kept) continue;
    const node = nodes.get(hash)!;
    const m = byHash.get(hash)!;
    if (m.kind === 'comment' || m.parentMessageHash === undefined) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(m.parentMessageHash.toLowerCase());
    if (parent === undefined) continue; // unreachable; classify would have dropped
    parent.children.push(node);
  }

  sortRecursive(roots);
  return { roots };
}

const cmp = (a: CommentNode, b: CommentNode): number => {
  if (a.message.timestamp !== b.message.timestamp) {
    return a.message.timestamp - b.message.timestamp;
  }
  return a.message.messageHash
    .toLowerCase()
    .localeCompare(b.message.messageHash.toLowerCase());
};

function sortRecursive(arr: CommentNode[]): void {
  arr.sort(cmp);
  for (const n of arr) sortRecursive(n.children);
}

/**
 * Walks a message's parent chain inside the bucket. Returns
 * `{ kept: true, depth }` if the chain terminates at a top-level
 * comment, or `{ kept: false }` if the chain hits a missing
 * message (orphan) or cycles back on itself.
 */
function classify(
  m: DecodedMessage,
  byHash: ReadonlyMap<string, DecodedMessage>
): { kept: true; depth: number } | { kept: false } {
  if (m.kind === 'comment') {
    return { kept: true, depth: 0 };
  }
  const visited = new Set<string>();
  visited.add(m.messageHash.toLowerCase());

  let cur: DecodedMessage = m;
  let depth = 0;
  while (cur.kind === 'reply') {
    if (cur.parentMessageHash === undefined) return { kept: false };
    const parentHash = cur.parentMessageHash.toLowerCase();
    if (visited.has(parentHash)) {
      // Cycle: chain reaches a node we already saw.
      return { kept: false };
    }
    const parent = byHash.get(parentHash);
    if (parent === undefined) {
      // Orphan: parent not in the bucket.
      return { kept: false };
    }
    visited.add(parentHash);
    cur = parent;
    depth += 1;
  }
  // Loop exited because `cur.kind === 'comment'`.
  return { kept: true, depth };
}
