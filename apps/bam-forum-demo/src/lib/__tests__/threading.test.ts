import { describe, expect, it } from 'vitest';

import type {
  ForumMessage,
  LikeRow,
  PostRow,
  ReplyRow,
} from '../forum-row';
import {
  buildThreads,
  getThread,
  indexLikesBySender,
} from '../threading';

const SENDER_A = '0x' + 'aa'.repeat(20);
const SENDER_B = '0x' + 'bb'.repeat(20);
const SENDER_C = '0x' + 'cc'.repeat(20);

const FORUM_TAG = '0x01bc15' + '00'.repeat(29);

function postRow(messageHash: string, timestamp: number): PostRow {
  return {
    kind: 'post',
    messageHash: messageHash as `0x${string}`,
    sender: SENDER_A as `0x${string}`,
    senderEns: null,
    nonce: '0',
    timestamp,
    status: 'confirmed',
    txHash: null,
    blockNumber: 1,
    title: 't',
    tag: '',
    body: 'b',
  };
}

function replyRow(
  messageHash: string,
  parent: string,
  timestamp: number,
  sender = SENDER_B
): ReplyRow {
  return {
    kind: 'reply',
    messageHash: messageHash as `0x${string}`,
    sender: sender as `0x${string}`,
    senderEns: null,
    nonce: '0',
    timestamp,
    status: 'confirmed',
    txHash: null,
    blockNumber: 1,
    parentMessageHash: parent as `0x${string}`,
    body: 'r',
  };
}

function likeRow(
  messageHash: string,
  target: string,
  sender: string
): LikeRow {
  return {
    kind: 'like',
    messageHash: messageHash as `0x${string}`,
    sender: sender as `0x${string}`,
    senderEns: null,
    nonce: '0',
    timestamp: 0,
    status: 'confirmed',
    txHash: null,
    blockNumber: 1,
    targetMessageHash: target as `0x${string}`,
  };
}

describe('buildThreads', () => {
  it('groups replies under their post by parentMessageHash, ascending by timestamp', () => {
    const rows: ForumMessage[] = [
      postRow('0x1' + '0'.repeat(63), 100),
      replyRow('0xr2' + '0'.repeat(62), '0x1' + '0'.repeat(63), 200),
      replyRow('0xr1' + '0'.repeat(62), '0x1' + '0'.repeat(63), 150),
    ];
    const threads = buildThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((r) => r.messageHash)).toEqual([
      '0xr1' + '0'.repeat(62),
      '0xr2' + '0'.repeat(62),
    ]);
  });

  it('drops orphan replies (no matching post in the window)', () => {
    const rows: ForumMessage[] = [
      postRow('0x1' + '0'.repeat(63), 100),
      replyRow('0xrx' + '0'.repeat(62), '0xMISSING' + '0'.repeat(58), 200),
    ];
    const threads = buildThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies).toHaveLength(0);
  });

  it('counts likes by distinct sender (dedup duplicate likes from same wallet)', () => {
    const post = '0x1' + '0'.repeat(63);
    const rows: ForumMessage[] = [
      postRow(post, 100),
      likeRow('0xl1' + '0'.repeat(62), post, SENDER_B),
      likeRow('0xl2' + '0'.repeat(62), post, SENDER_B),
      likeRow('0xl3' + '0'.repeat(62), post, SENDER_C),
    ];
    const threads = buildThreads(rows);
    expect(threads[0].likeCount).toBe(2);
    expect(threads[0].alreadyLikedBy(SENDER_B)).toBe(true);
    expect(threads[0].alreadyLikedBy(SENDER_C)).toBe(true);
    expect(threads[0].alreadyLikedBy(SENDER_A)).toBe(false);
  });

  it('alreadyLikedBy is case-insensitive on the viewer address', () => {
    const post = '0x1' + '0'.repeat(63);
    const upper = '0xDDDD' + 'DD'.repeat(18);
    const lower = upper.toLowerCase();
    const rows: ForumMessage[] = [
      postRow(post, 100),
      likeRow('0xl1' + '0'.repeat(62), post, lower),
    ];
    const [t] = buildThreads(rows);
    expect(t.alreadyLikedBy(upper)).toBe(true);
    expect(t.alreadyLikedBy(lower)).toBe(true);
    expect(t.alreadyLikedBy(null)).toBe(false);
  });
});

describe('getThread', () => {
  it('returns null when the post is not in the row set', () => {
    const rows: ForumMessage[] = [postRow('0x1' + '0'.repeat(63), 100)];
    expect(getThread(rows, '0xNOMATCH' + '0'.repeat(58))).toBeNull();
  });

  it('returns the thread when present, with same shape as buildThreads', () => {
    const post = '0x1' + '0'.repeat(63);
    const rows: ForumMessage[] = [
      postRow(post, 100),
      replyRow('0xr1' + '0'.repeat(62), post, 150),
      likeRow('0xl1' + '0'.repeat(62), post, SENDER_B),
    ];
    const t = getThread(rows, post);
    expect(t).not.toBeNull();
    expect(t!.post.messageHash).toBe(post);
    expect(t!.replies).toHaveLength(1);
    expect(t!.likeCount).toBe(1);
  });
});

describe('indexLikesBySender', () => {
  it('groups likes by target, with lowercased sender set', () => {
    const target1 = '0x1' + '0'.repeat(63);
    const target2 = '0x2' + '0'.repeat(63);
    const rows: ForumMessage[] = [
      likeRow('0xl1' + '0'.repeat(62), target1, SENDER_B),
      likeRow('0xl2' + '0'.repeat(62), target1, SENDER_C),
      likeRow('0xl3' + '0'.repeat(62), target2, SENDER_B),
    ];
    const index = indexLikesBySender(rows);
    expect(index.get(target1)!.size).toBe(2);
    expect(index.get(target2)!.size).toBe(1);
    expect(index.get(target1)!.has(SENDER_B.toLowerCase())).toBe(true);
  });
});
