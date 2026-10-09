/**
 * Pure maths for scene morphs (see session.morph in project-schema.ts): easing, colour
 * and angle lerps, and the "lerp plan" that blends two configs of the same shape.
 *
 * A plan is built once when a morph starts (allocation allowed then). Applying it each
 * frame only writes numbers and references into a scratch copy of the target: no objects
 * are created, except one short string when a hex colour's 8-bit value actually changes.
 *
 * Rules, by leaf:
 *   numbers                lerp (integer-only fields such as gridColumns are rounded)
 *   number tuples, objects recurse, so tuples lerp component-wise
 *   "#rrggbb" colours      lerp in (sRGB) RGB
 *   anything else          booleans, enums, strings, nulls, and any subtree whose shape
 *                          differs on the two sides: the "from" value until u = 0.5, then
 *                          the target's
 * Endpoints are exact: at u = 0 the scratch equals `from`, at u = 1 it equals the target.
 */

import type { LayerEffects } from './layer-schema.ts';
import type { Dof } from './project-schema.ts';

export type MorphEasing = 'linear' | 'smooth' | 'ease-in' | 'ease-out';

/** Morph progress 0..1 at wall time `nowMs` (clamped), before easing. */
export function morphProgress(nowMs: number, startWallMs: number, durationS: number): number {
  const span = durationS * 1000;
  if (!(span > 0)) return 1;
  const t = (nowMs - startWallMs) / span;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Ease a clamped progress value; exact at 0 and 1. */
export function ease(easing: MorphEasing, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (easing) {
    case 'linear':
      return x;
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'ease-in':
      return x * x * x;
    case 'ease-out': {
      const y = 1 - x;
      return 1 - y * y * y;
    }
  }
}

/** Linear interpolation, exact at both ends (a at u = 0, b at u = 1). */
export function lerp(a: number, b: number, u: number): number {
  return a * (1 - u) + b * u;
}

/** Degrees by the shortest way round; exactly a at u = 0 and b at u = 1. */
export function lerpAngle(a: number, b: number, u: number): number {
  if (u <= 0) return a;
  if (u >= 1) return b;
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return a + d * u;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColour(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return 0;
}

/** Parse "#rrggbb" into 0..255 components without allocating. */
export function parseHex(hex: string, out: RGB): RGB {
  out.r = hexDigit(hex.charCodeAt(1)) * 16 + hexDigit(hex.charCodeAt(2));
  out.g = hexDigit(hex.charCodeAt(3)) * 16 + hexDigit(hex.charCodeAt(4));
  out.b = hexDigit(hex.charCodeAt(5)) * 16 + hexDigit(hex.charCodeAt(6));
  return out;
}

const HEX2: string[] = [];
for (let i = 0; i < 256; i++) HEX2.push(i.toString(16).padStart(2, '0'));

export function hexFromRGB(r: number, g: number, b: number): string {
  const c = (v: number) => HEX2[v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)]!;
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Hex colour lerp in RGB; returns exactly `a` at u = 0 and `b` at u = 1. */
export function lerpHex(a: string, b: string, u: number): string {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const x = parseHex(a, { r: 0, g: 0, b: 0 });
  const y = parseHex(b, { r: 0, g: 0, b: 0 });
  return hexFromRGB(lerp(x.r, y.r, u), lerp(x.g, y.g, u), lerp(x.b, y.b, u));
}

/** Layer-schema fields that must stay whole numbers (z.number().int()). */
export const INTEGER_KEYS: ReadonlySet<string> = new Set(['gridColumns', 'count', 'dataStep', 'steps', 'chunkRows', 'columns', 'labelDepth']);

type Key = string | number;
type Node = Record<Key, unknown>;

const NUM = 0;
const INT = 1;
const COLOUR = 2;
const SWITCH = 3;
const TARGET = 4;

interface Op {
  kind: typeof NUM | typeof INT | typeof COLOUR | typeof SWITCH | typeof TARGET;
  /** Path of the leaf from the root (walked in the target each frame). */
  path: Key[];
  /** Scratch object holding the leaf, and its key there. */
  parent: Node;
  key: Key;
  /** Frozen "from" value (number, string or a private deep copy of a subtree). */
  from: unknown;
  fromRGB: RGB;
  /** Last colour written, so the hex string is only rebuilt when the 8-bit value changes. */
  lastR: number;
  lastG: number;
  lastB: number;
  lastHex: string;
}

export interface LerpPlan<T> {
  /** Receives the blend; layers are applied from it. Owned by the plan. */
  readonly scratch: T;
  readonly ops: readonly Op[];
}

export interface PlanOptions {
  /** Top-level keys that always take the target's value (blended some other way). */
  targetOnly?: ReadonlySet<string>;
}

const scratchRGB: RGB = { r: 0, g: 0, b: 0 };

/**
 * Build a plan blending `from` (frozen: deep-copied now) into whatever target is passed to
 * applyLerpPlan, which must have the shape `to` has now.
 */
export function buildLerpPlan<T>(from: T, to: T, options: PlanOptions = {}): LerpPlan<T> {
  const frozen = structuredClone(from) as unknown;
  const scratch = structuredClone(to) as unknown;
  const ops: Op[] = [];
  const op = (kind: Op['kind'], path: Key[], parent: Node, key: Key, fromValue: unknown): void => {
    const fromRGB = { r: 0, g: 0, b: 0 };
    if (kind === COLOUR) parseHex(fromValue as string, fromRGB);
    ops.push({ kind, path, parent, key, from: fromValue, fromRGB, lastR: -1, lastG: -1, lastB: -1, lastHex: '' });
  };

  const walk = (a: unknown, b: unknown, parent: Node, key: Key, path: Key[], top: boolean): void => {
    if (top && options.targetOnly?.has(String(key))) {
      op(TARGET, path, parent, key, undefined);
      return;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      op(typeof key === 'string' && INTEGER_KEYS.has(key) ? INT : NUM, path, parent, key, a);
      return;
    }
    if (isHexColour(a) && isHexColour(b)) {
      op(COLOUR, path, parent, key, a);
      return;
    }
    if (sameShape(a, b)) {
      const child = parent[key] as Node;
      for (const k of Array.isArray(b) ? b.keys() : Object.keys(b as Node)) {
        walk((a as Node)[k], (b as Node)[k], child, k, [...path, k], false);
      }
      return;
    }
    op(SWITCH, path, parent, key, a);
  };

  if (sameShape(frozen, scratch) && !Array.isArray(scratch)) {
    const root = scratch as Node;
    for (const k of Object.keys(root)) walk((frozen as Node)[k], (to as Node)[k], root, k, [k], true);
    return { scratch: scratch as T, ops };
  }
  // Not two objects of the same shape: the whole value switches at the midpoint. Wrap it
  // so the switch has a parent to write into.
  const box: Node = { v: scratch };
  walk(frozen, to, box, 'v', [], false);
  return {
    get scratch() {
      return box.v as T;
    },
    ops,
  };
}

/** Blend into plan.scratch at eased progress `u` (0..1) towards `to`; returns the scratch. */
export function applyLerpPlan<T>(plan: LerpPlan<T>, to: T, u: number): T {
  const ops = plan.ops;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!;
    // Walk to the leaf in the current target (shapes match by construction; anything
    // unexpected leaves the scratch value as it was).
    let node: unknown = to;
    const path = o.path;
    for (let j = 0; j < path.length; j++) {
      if (typeof node !== 'object' || node === null) {
        node = undefined;
        break;
      }
      node = (node as Node)[path[j]!];
    }
    switch (o.kind) {
      case NUM:
        if (typeof node === 'number') o.parent[o.key] = u <= 0 ? (o.from as number) : u >= 1 ? node : lerp(o.from as number, node, u);
        break;
      case INT:
        if (typeof node === 'number') o.parent[o.key] = u <= 0 ? (o.from as number) : u >= 1 ? node : Math.round(lerp(o.from as number, node, u));
        break;
      case COLOUR: {
        if (!isHexColourFast(node)) break;
        if (u <= 0) {
          o.parent[o.key] = o.from;
          break;
        }
        if (u >= 1) {
          o.parent[o.key] = node;
          break;
        }
        const t = parseHex(node, scratchRGB);
        const r = Math.round(lerp(o.fromRGB.r, t.r, u));
        const g = Math.round(lerp(o.fromRGB.g, t.g, u));
        const b = Math.round(lerp(o.fromRGB.b, t.b, u));
        if (r !== o.lastR || g !== o.lastG || b !== o.lastB) {
          o.lastR = r;
          o.lastG = g;
          o.lastB = b;
          o.lastHex = hexFromRGB(r, g, b);
        }
        o.parent[o.key] = o.lastHex;
        break;
      }
      case SWITCH:
        o.parent[o.key] = u < 0.5 ? o.from : node;
        break;
      case TARGET:
        o.parent[o.key] = node;
        break;
    }
  }
  return plan.scratch;
}

function isHexColourFast(v: unknown): v is string {
  return typeof v === 'string' && v.length === 7 && v.charCodeAt(0) === 35;
}

/** Both plain objects with the same keys, or both arrays of the same length. */
function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
  return true;
}

// ---- camera and output -------------------------------------------------------------

export interface MorphCamera {
  mode: '2d' | '3d';
  fov: number;
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
  /** Switches to the target's at once (a projection cannot be blended). */
  projection: 'perspective' | 'isometric';
  dof: Dof;
}

/**
 * Camera blend into `out`. Numbers lerp, yaw goes the shortest way round. A 2D camera is
 * treated as the 3D camera that frames the same picture (yaw = pitch = 0, distance 1,
 * target centred; see CameraSchema), so a 2D <-> 3D morph is a continuous camera move:
 * 2D -> 3D switches to the perspective camera at the start, 3D -> 2D at the end. Depth of
 * field blends as lerpDof does. Exact at u = 0 and u = 1.
 */
export function lerpCamera(from: MorphCamera, to: MorphCamera, u: number, out: MorphCamera): MorphCamera {
  const src = u <= 0 ? from : to;
  out.projection = u <= 0 ? from.projection : to.projection;
  lerpDof(from.dof, to.dof, u, out.dof);
  if (u <= 0 || u >= 1) {
    out.mode = src.mode;
    out.fov = src.fov;
    out.yaw = src.yaw;
    out.pitch = src.pitch;
    out.distance = src.distance;
    out.target[0] = src.target[0];
    out.target[1] = src.target[1];
    out.target[2] = src.target[2];
    return out;
  }
  const flatFrom = from.mode === '2d';
  const flatTo = to.mode === '2d';
  if (flatFrom && flatTo) {
    // Nothing moves a 2D camera; carry the target's (unused) 3D settings.
    return lerpCamera(from, to, 1, out);
  }
  out.mode = '3d';
  out.fov = lerp(flatFrom ? to.fov : from.fov, flatTo ? from.fov : to.fov, u);
  out.yaw = lerpAngle(flatFrom ? 0 : from.yaw, flatTo ? 0 : to.yaw, u);
  out.pitch = lerp(flatFrom ? 0 : from.pitch, flatTo ? 0 : to.pitch, u);
  out.distance = lerp(flatFrom ? 1 : from.distance, flatTo ? 1 : to.distance, u);
  for (let i = 0; i < 3; i++) {
    out.target[i] = lerp(flatFrom ? 0 : from.target[i]!, flatTo ? 0 : to.target[i]!, u);
  }
  return out;
}

/**
 * Depth of field blend into `out`. Numbers lerp; switched on or off by the morph, it stays on
 * for the whole morph while its blur ramps from or to zero, at the focus of the side that has
 * it. Exact at u = 0 and u = 1.
 */
export function lerpDof(from: Dof, to: Dof, u: number, out: Dof): Dof {
  if (u <= 0 || u >= 1 || (!from.enabled && !to.enabled)) {
    const src = u <= 0 ? from : to;
    out.enabled = src.enabled;
    out.focus = src.focus;
    out.depth = src.depth;
    out.amount = src.amount;
    return out;
  }
  const a = from.enabled ? from : to;
  const b = to.enabled ? to : from;
  out.enabled = true;
  out.focus = lerp(a.focus, b.focus, u);
  out.depth = lerp(a.depth, b.depth, u);
  out.amount = lerp(from.enabled ? from.amount : 0, to.enabled ? to.amount : 0, u);
  return out;
}

/**
 * A layer's glow and trails blend into `out`. Numbers lerp. An effect switched on or off by
 * the morph fades instead of popping: it stays enabled for the whole morph while its amount
 * (glow strength, trail persistence) ramps from or to zero. Exact at u = 0 and u = 1.
 */
export function lerpEffects(from: LayerEffects, to: LayerEffects, u: number, out: LayerEffects): LayerEffects {
  if (u <= 0 || u >= 1) {
    const src = u <= 0 ? from : to;
    out.glow.enabled = src.glow.enabled;
    out.glow.strength = src.glow.strength;
    out.glow.radius = src.glow.radius;
    out.glow.threshold = src.glow.threshold;
    out.trails.enabled = src.trails.enabled;
    out.trails.persistence = src.trails.persistence;
    return out;
  }
  const fg = from.glow;
  const tg = to.glow;
  out.glow.enabled = fg.enabled || tg.enabled;
  out.glow.strength = lerp(fg.enabled ? fg.strength : 0, tg.enabled ? tg.strength : 0, u);
  out.glow.radius = lerp(fg.enabled ? fg.radius : tg.radius, tg.enabled ? tg.radius : fg.radius, u);
  out.glow.threshold = lerp(fg.enabled ? fg.threshold : tg.threshold, tg.enabled ? tg.threshold : fg.threshold, u);
  const ft = from.trails;
  const tt = to.trails;
  out.trails.enabled = ft.enabled || tt.enabled;
  out.trails.persistence = lerp(ft.enabled ? ft.persistence : 0, tt.enabled ? tt.persistence : 0, u);
  return out;
}
