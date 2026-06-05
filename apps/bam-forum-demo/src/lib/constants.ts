/**
 * Cross-cutting constants for the forum demo.
 *
 * `FORUM_TAG` is re-exported so server-side route handlers don't need
 * to import the codec module (which pulls in @noble/hashes); they just
 * need the 32-byte hex value to forward to the poster + reader.
 */

import { FORUM_TAG } from 'bam-sdk/forum';

export { FORUM_TAG };

export const SEPOLIA_CHAIN_ID = 11155111;

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 4000;
export const MAX_REPLY_CHARS = 2000;
export const MAX_TAG_BYTES = 32;

/** Recent confirmed-message window the API fetches per refetch. */
export const READER_WINDOW = 200;
/** Coprocessor /validation/latest + /proof window — match reader window. */
export const COPROCESSOR_WINDOW = 200;
