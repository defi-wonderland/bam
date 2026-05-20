/**
 * Registry contract: unique tag / name / schema, lookup by tag and
 * by name, ordered iteration.
 */

import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { HandlerRegistry } from '../../src/framework/registry.js';
import type { IndexerHandler } from '../../src/framework/handler.js';

function stub(
  contentTag: string,
  name: string,
  schema: string
): IndexerHandler<unknown> {
  return {
    contentTag: contentTag as Bytes32,
    name,
    version: 1,
    schema,
    async migrate() {
      /* noop */
    },
    decode() {
      return null;
    },
    async project() {
      /* noop */
    },
    async onReorg() {
      /* noop */
    },
    routes: [],
  };
}

describe('HandlerRegistry', () => {
  it('looks up by content tag', () => {
    const a = stub('0x' + 'aa'.repeat(32), 'a', 'a');
    const b = stub('0x' + 'bb'.repeat(32), 'b', 'b');
    const r = new HandlerRegistry([a, b]);
    expect(r.byContentTag(a.contentTag)).toBe(a);
    expect(r.byContentTag(b.contentTag)).toBe(b);
    expect(r.byContentTag(('0x' + 'cc'.repeat(32)) as Bytes32)).toBeUndefined();
  });

  it('lookup is case-insensitive (matches the uniqueness invariant)', () => {
    // Handler registered with mixed-case tag…
    const tagMixed = ('0x' + 'AbCd'.repeat(16)) as Bytes32;
    const a = stub(tagMixed, 'a', 'a');
    const r = new HandlerRegistry([a]);
    // …and the same tag in lowercase / uppercase both resolve to it.
    expect(r.byContentTag(tagMixed.toLowerCase() as Bytes32)).toBe(a);
    expect(r.byContentTag(tagMixed.toUpperCase().replace('0X', '0x') as Bytes32)).toBe(a);
  });

  it('rejects duplicate contentTag', () => {
    const a = stub('0x' + 'aa'.repeat(32), 'a', 'a');
    const b = stub('0x' + 'aa'.repeat(32), 'b', 'b');
    expect(() => new HandlerRegistry([a, b])).toThrow(/duplicate contentTag/);
  });

  it('rejects duplicate name', () => {
    const a = stub('0x' + 'aa'.repeat(32), 'shared', 'a');
    const b = stub('0x' + 'bb'.repeat(32), 'shared', 'b');
    expect(() => new HandlerRegistry([a, b])).toThrow(/duplicate handler name/);
  });

  it('rejects duplicate schema', () => {
    const a = stub('0x' + 'aa'.repeat(32), 'a', 'shared');
    const b = stub('0x' + 'bb'.repeat(32), 'b', 'shared');
    expect(() => new HandlerRegistry([a, b])).toThrow(/duplicate handler schema/);
  });

  it('get by name throws UnknownHandlerError on miss', () => {
    const r = new HandlerRegistry([stub('0x' + 'aa'.repeat(32), 'a', 'a')]);
    expect(() => r.get('z')).toThrow(/no handler named "z" is registered/);
  });

  it('preserves construction order in `all()`', () => {
    const order = ['x', 'y', 'z'].map((n, i) =>
      stub('0x' + n.repeat(64).slice(0, 64), n, n)
    );
    const r = new HandlerRegistry(order);
    expect(r.all().map((h) => h.name)).toEqual(['x', 'y', 'z']);
  });
});
