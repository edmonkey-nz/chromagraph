import { describe, expect, it } from 'vitest';
import { applyOps, getAt, isPatchOp, PatchError } from '../../src/shared/patch.ts';

const doc = () => ({ a: { b: 1, c: [10, 20, 30] }, d: { e: 'x' } });

describe('applyOps', () => {
  it('sets a nested value without mutating the input', () => {
    const before = doc();
    const after = applyOps(before, [{ op: 'set', path: ['a', 'b'], value: 2 }]);
    expect(after.a.b).toBe(2);
    expect(before.a.b).toBe(1);
  });

  it('keeps identity of untouched branches', () => {
    const before = doc();
    const after = applyOps(before, [{ op: 'set', path: ['a', 'b'], value: 2 }]);
    expect(after.d).toBe(before.d);
    expect(after.a).not.toBe(before.a);
  });

  it('sets, appends and removes array items', () => {
    let d = applyOps(doc(), [{ op: 'set', path: ['a', 'c', 1], value: 21 }]);
    expect(d.a.c).toEqual([10, 21, 30]);
    d = applyOps(d, [{ op: 'set', path: ['a', 'c', 3], value: 40 }]);
    expect(d.a.c).toEqual([10, 21, 30, 40]);
    d = applyOps(d, [{ op: 'remove', path: ['a', 'c', 0] }]);
    expect(d.a.c).toEqual([21, 30, 40]);
  });

  it('adds and removes object keys', () => {
    let d: Record<string, unknown> = applyOps(doc(), [{ op: 'set', path: ['d', 'f'], value: true }]);
    expect(getAt(d, ['d', 'f'])).toBe(true);
    d = applyOps(d, [{ op: 'remove', path: ['d', 'e'] }]);
    expect(getAt(d, ['d', 'e'])).toBeUndefined();
  });

  it('applies ops in order', () => {
    const d = applyOps(doc(), [
      { op: 'set', path: ['a', 'b'], value: 5 },
      { op: 'set', path: ['a', 'b'], value: 6 },
    ]);
    expect(d.a.b).toBe(6);
  });

  it('rejects bad paths', () => {
    expect(() => applyOps(doc(), [{ op: 'set', path: ['missing', 'x'], value: 1 }])).toThrow(PatchError);
    expect(() => applyOps(doc(), [{ op: 'set', path: ['a', 'b', 'x'], value: 1 }])).toThrow(PatchError);
    expect(() => applyOps(doc(), [{ op: 'set', path: ['a', 'c', 9], value: 1 }])).toThrow(PatchError);
    expect(() => applyOps(doc(), [{ op: 'set', path: ['a', 'c', 'x'], value: 1 }])).toThrow(PatchError);
    expect(() => applyOps(doc(), [{ op: 'remove', path: ['a', 'c', 5] }])).toThrow(PatchError);
  });

  it('refuses prototype keys', () => {
    expect(() => applyOps(doc(), [{ op: 'set', path: ['__proto__', 'polluted'], value: 1 }])).toThrow(PatchError);
    expect(() => applyOps(doc(), [{ op: 'set', path: ['a', 'constructor'], value: 1 }])).toThrow(PatchError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('isPatchOp', () => {
  it('validates op shape', () => {
    expect(isPatchOp({ op: 'set', path: ['a'], value: 1 })).toBe(true);
    expect(isPatchOp({ op: 'set', path: ['a'], value: undefined })).toBe(true);
    expect(isPatchOp({ op: 'remove', path: ['a', 0] })).toBe(true);
    expect(isPatchOp({ op: 'set', path: ['a'] })).toBe(false);
    expect(isPatchOp({ op: 'set', path: [], value: 1 })).toBe(false);
    expect(isPatchOp({ op: 'move', path: ['a'] })).toBe(false);
    expect(isPatchOp({ op: 'set', path: [1.5], value: 1 })).toBe(false);
    expect(isPatchOp(null)).toBe(false);
  });
});
