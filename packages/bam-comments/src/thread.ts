/**
 * Build a comment tree from a flat list of decoded BAM messages
 * already filtered down to the mounted post's `postIdHash`.
 *
 * Wire-level depth is preserved, but `displayDepth` is clamped to
 * `0 | 1 | 2` so the renderer can hide the reply affordance at the
 * deepest visible level. Three rules govern correctness:
 *
 * 1. Orphan replies (parent missing in this bucket) are dropped.
 * 2. Cycles in `parentMessageHash` chains are detected with a
 *    visited set and every node on the cycle is dropped.
 * 3. Order is `(timestamp asc, messageHash asc)` recursively, so the
 *    UI is stable across re-renders even when timestamps tie.
 */

export interface DecodedMessage {
  /** ERC-8180 messageHash, hex (lowercase, 0x-prefixed). */
  messageHash: `0x${string}`;
  sender: `0x${string}`;
  /** Wallet `address` lowercased for display de-duping. */
  senderLower: string;
  /** The post bucket this message belongs to (from the signed payload). */
  postIdHash: `0x${string}`;
  timestamp: number;
  content: string;
  parentMessageHash?: `0x${string}`;
  /** True for messages still sitting in the Poster's pending queue. */
  pending: boolean;
}

export interface CommentNode extends DecodedMessage {
  children: CommentNode[];
  /** Wire depth (root = 0, reply = 1, reply-of-reply = 2, ...). */
  depth: number;
  /** Renderer-facing depth, clamped to 0..2. */
  displayDepth: 0 | 1 | 2;
}

export interface ThreadResult {
  roots: CommentNode[];
}

export function buildThread(messages: DecodedMessage[]): ThreadResult {
  // Index by messageHash so every parent lookup is O(1). Duplicates
  // (same hash appearing twice) just keep the last — the wire format
  // makes hash-collision impractical and treating duplicates as
  // identical is fine for display.
  const byHash = new Map<string, DecodedMessage>();
  for (const m of messages) {
    byHash.set(m.messageHash.toLowerCase(), m);
  }

  // Cycle / orphan filter.
  const survivors = new Map<string, DecodedMessage>();
  for (const m of messages) {
    if (!isReachableRoot(m, byHash)) continue;
    survivors.set(m.messageHash.toLowerCase(), m);
  }

  // Build child arrays from the survivor set.
  const childrenOf = new Map<string, CommentNode[]>();
  const allNodes = new Map<string, CommentNode>();
  for (const m of survivors.values()) {
    const node: CommentNode = {
      ...m,
      children: [],
      depth: 0,
      displayDepth: 0,
    };
    allNodes.set(m.messageHash.toLowerCase(), node);
  }

  const roots: CommentNode[] = [];
  for (const node of allNodes.values()) {
    const parentKey = node.parentMessageHash?.toLowerCase();
    if (parentKey && allNodes.has(parentKey)) {
      const arr = childrenOf.get(parentKey) ?? [];
      arr.push(node);
      childrenOf.set(parentKey, arr);
    } else {
      roots.push(node);
    }
  }

  // Attach children + assign wire/display depth via BFS so a parent
  // is always assigned before its children.
  const queue: CommentNode[] = [...roots];
  while (queue.length > 0) {
    const node = queue.shift() as CommentNode;
    const kids = childrenOf.get(node.messageHash.toLowerCase()) ?? [];
    kids.sort(compareNodes);
    for (const k of kids) {
      k.depth = node.depth + 1;
      k.displayDepth = clampDepth(k.depth);
      node.children.push(k);
      queue.push(k);
    }
  }

  roots.sort(compareNodes);
  return { roots };
}

function compareNodes(a: DecodedMessage, b: DecodedMessage): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.messageHash.localeCompare(b.messageHash);
}

function clampDepth(d: number): 0 | 1 | 2 {
  if (d <= 0) return 0;
  if (d >= 2) return 2;
  return 1;
}

/**
 * Walk parent links upward; return false if we revisit a node
 * (self-cycle or longer cycle) or hit `undefined` having walked past
 * the configured cap. A root (no parent at all) is reachable.
 */
function isReachableRoot(
  start: DecodedMessage,
  byHash: Map<string, DecodedMessage>
): boolean {
  const visited = new Set<string>();
  let cursor: DecodedMessage | undefined = start;
  // Hard cap matches the wire format's worst-case depth-3 input.
  // Anything longer is treated as cycle-suspect and dropped — the
  // widget never displays past depth 2 anyway.
  const HARD_CAP = 1024;
  for (let i = 0; i < HARD_CAP; i++) {
    if (cursor === undefined) return true;
    const key = cursor.messageHash.toLowerCase();
    if (visited.has(key)) return false;
    visited.add(key);
    const parent = cursor.parentMessageHash?.toLowerCase();
    if (parent === undefined) return true;
    const next = byHash.get(parent);
    if (next === undefined) {
      // Orphan: parent missing in bucket.
      return false;
    }
    cursor = next;
  }
  return false;
}
