/**
 * Thread builder. Takes a flat list of decoded messages (a mix of
 * pending and confirmed `comment`s and `reply`s, possibly across
 * multiple posts) and produces a per-post tree clamped to two
 * levels of visual nesting.
 *
 * Rules — single source of truth for the demo's per-post grouping
 * and depth policy:
 *
 *   1. Messages whose `postIdHash` is not in `KNOWN_POST_IDS` are
 *      dropped silently.
 *
 *   2. Messages are bucketed by `postIdHash`. A reply whose
 *      parent lives under a different post never resolves
 *      (different bucket) and is hidden as an orphan.
 *
 *   3. Within a bucket, a reply is followed up its parent chain
 *      (`parentMessageHash` lookups). If the chain hits a missing
 *      message, the reply is hidden (orphan). If a cycle is
 *      detected, every node on the cycle is dropped (data is
 *      adversarial or corrupted).
 *
 *   4. The tree is the true (unclamped) parent-child structure,
 *      but each node carries a `displayDepth` of
 *      `min(actualDepth, 2)` so the renderer indents at most two
 *      levels regardless of how deep the wire-level chain goes.
 *
 *   5. Children and roots are sorted by
 *      `(timestamp asc, messageHash asc)` for stable ordering.
 */

import type { Hex } from 'viem';

import { postIdHashToSlug } from './post-id.js';

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

export interface PostThread {
  readonly postIdHash: Hex;
  readonly slug: string;
  readonly roots: CommentNode[];
}

const MAX_DISPLAY_DEPTH = 2;

/**
 * Build per-post threads. Returns a map keyed on slug; posts with
 * no surviving messages do not appear in the map (callers render
 * an empty state).
 */
export function buildThreads(
  messages: readonly DecodedMessage[]
): Map<string, PostThread> {
  // (1) drop unknown postIdHash, (2) group by postIdHash.
  const byPost = new Map<Hex, DecodedMessage[]>();
  for (const m of messages) {
    const key = m.postIdHash.toLowerCase() as Hex;
    if (postIdHashToSlug(key) === null) continue;
    let bucket = byPost.get(key);
    if (bucket === undefined) {
      bucket = [];
      byPost.set(key, bucket);
    }
    bucket.push(m);
  }

  const out = new Map<string, PostThread>();
  for (const [postIdHash, bucket] of byPost) {
    const slug = postIdHashToSlug(postIdHash);
    if (slug === null) continue; // unreachable; satisfies TS
    const thread = buildSinglePost(postIdHash, slug, bucket);
    if (thread.roots.length > 0) {
      out.set(slug, thread);
    }
  }
  return out;
}

function buildSinglePost(
  postIdHash: Hex,
  slug: string,
  bucket: readonly DecodedMessage[]
): PostThread {
  // messageHash → message inside this post, lowercased keys.
  const byHash = new Map<string, DecodedMessage>();
  for (const m of bucket) {
    byHash.set(m.messageHash.toLowerCase(), m);
  }

  // Classify every message: kept with a depth, or dropped (orphan / cycle).
  type Classification = { kept: true; depth: number } | { kept: false };
  const classified = new Map<string, Classification>();
  for (const m of bucket) {
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
  return { postIdHash, slug, roots };
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
 * Walks a message's parent chain inside the post bucket. Returns
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
      // Orphan: parent not in this post's bucket.
      return { kept: false };
    }
    visited.add(parentHash);
    cur = parent;
    depth += 1;
  }
  // Loop exited because `cur.kind === 'comment'`.
  return { kept: true, depth };
}
