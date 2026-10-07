/**
 * Minimal structural patches. Paths are arrays of object keys / array indices.
 * `applyOps` copies only along the changed paths, so unchanged branches keep their
 * identity and consumers can detect change with `!==`.
 */

export type PathSegment = string | number;
export type Path = PathSegment[];

export type PatchOp =
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'remove'; path: Path };

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export class PatchError extends Error {}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

function shallowCopy(v: Record<string, unknown> | unknown[]): Record<string, unknown> | unknown[] {
  return Array.isArray(v) ? v.slice() : { ...v };
}

function applyOne(node: unknown, op: PatchOp, depth: number): unknown {
  const key = op.path[depth];
  if (key === undefined) {
    if (op.op === 'remove') throw new PatchError('cannot remove the root');
    return op.value;
  }
  if (typeof key === 'string' && FORBIDDEN.has(key)) throw new PatchError(`forbidden key "${key}"`);
  if (!isContainer(node)) throw new PatchError(`path ${op.path.join('.')} runs through a non-object`);

  const last = depth === op.path.length - 1;
  const copy = shallowCopy(node);

  if (Array.isArray(copy)) {
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0) {
      throw new PatchError(`array index expected at ${op.path.slice(0, depth + 1).join('.')}`);
    }
    if (last && op.op === 'remove') {
      if (key >= copy.length) throw new PatchError(`index ${key} out of range`);
      copy.splice(key, 1);
      return copy;
    }
    if (key > copy.length || (!last && key >= copy.length)) throw new PatchError(`index ${key} out of range`);
    copy[key] = applyOne(copy[key], op, depth + 1);
    return copy;
  }

  const k = String(key);
  if (last && op.op === 'remove') {
    delete copy[k];
    return copy;
  }
  if (!last && !Object.hasOwn(copy, k)) throw new PatchError(`missing key "${k}"`);
  copy[k] = applyOne(copy[k], op, depth + 1);
  return copy;
}

/** Apply ops in order. Throws PatchError on an invalid op; the input is never mutated. */
export function applyOps<T>(doc: T, ops: readonly PatchOp[]): T {
  let out: unknown = doc;
  for (const op of ops) out = applyOne(out, op, 0);
  return out as T;
}

/** Read the value at a path, or undefined. */
export function getAt(doc: unknown, path: Path): unknown {
  let node = doc;
  for (const key of path) {
    if (!isContainer(node)) return undefined;
    node = (node as Record<string, unknown>)[String(key)];
  }
  return node;
}

export function isPatchOp(v: unknown): v is PatchOp {
  if (!isContainer(v) || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.op !== 'set' && o.op !== 'remove') return false;
  if (!Array.isArray(o.path) || o.path.length === 0) return false;
  if (!o.path.every((s) => typeof s === 'string' || (typeof s === 'number' && Number.isInteger(s)))) return false;
  if (o.op === 'set' && !('value' in o)) return false;
  return true;
}
