/**
 * The single normalized row shape every `/api/*` route returns and
 * every component consumes. Server pre-resolves the 4-state badge and
 * the decoded payload; the client just renders.
 */

import type { Address, Bytes32 } from 'bam-sdk/browser';

export type BadgeState = 'pending' | 'confirmed' | 'validated' | 'proven';

export interface ProofCommitment {
  provenAt: string;
  proofType: string;
  sp1Version: string;
  proofSize: number;
}

interface BaseRow {
  messageHash: Bytes32;
  sender: Address;
  senderEns: string | null;
  /** Decimal string — u64 nonce doesn't always fit JSON number. */
  nonce: string;
  /** Unix seconds, decoded from the message payload. */
  timestamp: number;
  status: BadgeState;
  /** Poster batch tx hash; null when pending or when reader hasn't observed yet. */
  txHash: string | null;
  blockNumber: number | null;
  proofCommitment?: ProofCommitment;
}

export interface PostRow extends BaseRow {
  kind: 'post';
  title: string;
  /** Free-text tag chosen by the post author (≤32 bytes UTF-8). May be empty. */
  tag: string;
  body: string;
}

export interface ReplyRow extends BaseRow {
  kind: 'reply';
  parentMessageHash: Bytes32;
  body: string;
}

export interface LikeRow extends BaseRow {
  kind: 'like';
  targetMessageHash: Bytes32;
}

export type ForumMessage = PostRow | ReplyRow | LikeRow;

export interface ProofCounts {
  validated: number;
  proven: number;
  /** ISO-8601 of the most recent proof in the current window, null if none. */
  latestProvenAt: string | null;
}
