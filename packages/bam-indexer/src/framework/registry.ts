/**
 * Lookup table over the registered handler set. Today it's a
 * trivial in-memory array — the indirection exists so the tick loop
 * and the HTTP server can ask "which handler owns `contentTag X`?"
 * and "what's mounted under `/twitter`?" without reaching into
 * `IndexerHandler` arrays directly.
 *
 * Out of scope for v1: dynamic loading from disk, npm-plugin
 * resolution, hot reload. Handlers are authored in-tree.
 */

import type { Bytes32 } from 'bam-sdk';

import type { IndexerHandler } from './handler.js';
import { UnknownHandlerError } from '../errors.js';

export class HandlerRegistry {
  private readonly byTag = new Map<Bytes32, IndexerHandler<unknown>>();
  private readonly byName = new Map<string, IndexerHandler<unknown>>();
  private readonly order: ReadonlyArray<IndexerHandler<unknown>>;

  constructor(handlers: ReadonlyArray<IndexerHandler<unknown>>) {
    const seenTag = new Set<string>();
    const seenName = new Set<string>();
    const seenSchema = new Set<string>();
    for (const h of handlers) {
      const tagKey = h.contentTag.toLowerCase() as Bytes32;
      if (seenTag.has(tagKey)) {
        throw new Error(
          `duplicate contentTag among handlers: ${h.contentTag} ` +
            `(handlers ${this.byTag.get(tagKey)?.name} and ${h.name})`
        );
      }
      if (seenName.has(h.name)) {
        throw new Error(`duplicate handler name: ${h.name}`);
      }
      if (seenSchema.has(h.schema)) {
        throw new Error(`duplicate handler schema: ${h.schema}`);
      }
      seenTag.add(tagKey);
      seenName.add(h.name);
      seenSchema.add(h.schema);
      // Store under the lowercased tag so lookups are case-insensitive
      // and stay consistent with the uniqueness invariant above.
      this.byTag.set(tagKey, h);
      this.byName.set(h.name, h);
    }
    this.order = handlers;
  }

  all(): ReadonlyArray<IndexerHandler<unknown>> {
    return this.order;
  }

  byContentTag(tag: Bytes32): IndexerHandler<unknown> | undefined {
    return this.byTag.get(tag.toLowerCase() as Bytes32);
  }

  get(name: string): IndexerHandler<unknown> {
    const h = this.byName.get(name);
    if (h === undefined) {
      throw new UnknownHandlerError(name, [...this.byName.keys()]);
    }
    return h;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}
