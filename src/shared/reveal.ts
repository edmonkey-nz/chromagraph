import type { LayerConfig } from './layer-schema.ts';
import { EASINGS, type Modulator, type Parameter } from './modulators.ts';
import { layerParamPrefix } from './parameters.ts';
import type { PatchOp } from './patch.ts';
import type { Project } from './project-schema.ts';

/**
 * A layer's "Animate" settings, read from and written to its row range and the modulators on
 * it. Pure, so it is tested in Node.
 *
 * Layers with a row range (`rows`, fractions 0..1) animate it on the timeline that drives
 * them (the project's, or the layer's own). `from` is where it starts, start <= from <= end:
 *   build   rows end ramps from -> end, so rows appear one after another (rows start..from
 *           already show when the timeline starts)
 *   window  rows end ramps from -> end and rows start ramps (from - w) -> (end - w), so a
 *           window of width w slides through (the output clamps a start below 0)
 * Text layers, which show one row, can follow the timeline: `row` ramps 0 -> 1.
 * Anything else on those parameters (an LFO, keyframes, a switched-off ramp) reads as
 * 'custom' and is left alone; it is edited under Motion effects.
 */

export const REVEAL_MODES = ['off', 'build', 'window', 'custom'] as const;
export type RevealMode = (typeof REVEAL_MODES)[number];
export type Easing = (typeof EASINGS)[number];

export interface Reveal {
  mode: RevealMode;
  /** The rows shown (when off), or the range the animation ends on, 0..1. */
  start: number;
  end: number;
  /** Where the rows end when the timeline starts, start..end (build and window). */
  from: number;
  /** Window width, 0..1 of the rows (window mode). */
  width: number;
  easing: Easing;
}

export const MIN_ROWS_GAP = 0.001;
export const MIN_WINDOW = 0.01;
export const DEFAULT_WINDOW = 0.1;

/** How a layer animates: a row range, one current row (text), or neither. */
export function animateKind(layer: LayerConfig): 'rows' | 'row' | null {
  switch (layer.type) {
    case 'text':
      return 'row';
    case 'instancer':
    case 'line':
    case 'heatmap':
    case 'multiples':
    case 'hierarchy':
    case 'surface':
    case 'density':
    case 'horizon':
      return 'rows';
    case 'reflector':
    case 'qr':
      return null;
  }
}

const paramPath = (id: string): (string | number)[] => ['project', 'parameters', id];
const rampOf = (p: Parameter | undefined): Extract<Modulator, { kind: 'ramp' }> | null =>
  p && p.modulator.kind === 'ramp' && p.modulator.enabled ? p.modulator : null;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** The layer's row animation, read back from its rows and their modulators. Null without a row range. */
export function readReveal(project: Project, layer: LayerConfig): Reveal | null {
  if (!('rows' in layer)) return null;
  const [base0, base1] = layer.rows;
  const p0 = project.parameters[`${layerParamPrefix(layer.id)}rows.0`];
  const p1 = project.parameters[`${layerParamPrefix(layer.id)}rows.1`];
  const off: Reveal = { mode: 'off', start: base0, end: base1, from: base0, width: DEFAULT_WINDOW, easing: 'linear' };
  if (!p0 && !p1) return off;
  const r1 = rampOf(p1);
  if (!r1 || r1.to < r1.from) return { ...off, mode: 'custom' };
  if (!p0) return { mode: 'build', start: Math.min(base0, r1.from), end: r1.to, from: r1.from, width: DEFAULT_WINDOW, easing: r1.easing };
  const r0 = rampOf(p0);
  const width = r1.from - (r0?.from ?? 0);
  if (r0 && r0.easing === r1.easing && width > 0 && near(r1.to - r0.to, width)) {
    return { mode: 'window', start: Math.min(base0, r1.from), end: r1.to, from: r1.from, width, easing: r1.easing };
  }
  return { ...off, mode: 'custom' };
}

/**
 * Ops that set a layer's row animation to `next`: the base row range becomes [start, end] (what
 * shows when the animation is off), and the modulators on rows.0 / rows.1 are replaced to match.
 * 'custom' only sets the base range and leaves the modulators alone.
 */
export function revealOps(project: Project, layerId: string, next: Reveal): PatchOp[] {
  const index = project.layers.findIndex((l) => l.id === layerId);
  const layer = project.layers[index];
  if (!layer || !('rows' in layer)) return [];
  const start = Math.min(Math.max(next.start, 0), 1 - MIN_ROWS_GAP);
  const end = Math.min(Math.max(next.end, start + MIN_ROWS_GAP), 1);
  const from = Math.min(Math.max(Number.isFinite(next.from) ? next.from : start, start), end);
  const ops: PatchOp[] = [{ op: 'set', path: ['project', 'layers', index, 'rows'], value: [start, end] }];
  const id0 = `${layerParamPrefix(layerId)}rows.0`;
  const id1 = `${layerParamPrefix(layerId)}rows.1`;
  const ramp = (from: number, to: number): Parameter => ({ modulator: { kind: 'ramp', enabled: true, from, to, easing: next.easing } });
  const has0 = project.parameters[id0] !== undefined;
  const has1 = project.parameters[id1] !== undefined;
  switch (next.mode) {
    case 'off':
      if (has0) ops.push({ op: 'remove', path: paramPath(id0) });
      if (has1) ops.push({ op: 'remove', path: paramPath(id1) });
      break;
    case 'build':
      if (has0) ops.push({ op: 'remove', path: paramPath(id0) });
      ops.push({ op: 'set', path: paramPath(id1), value: ramp(from, end) });
      break;
    case 'window': {
      const w = Math.min(Math.max(Number.isFinite(next.width) ? next.width : DEFAULT_WINDOW, MIN_WINDOW), 1);
      ops.push({ op: 'set', path: paramPath(id1), value: ramp(from, end) });
      ops.push({ op: 'set', path: paramPath(id0), value: ramp(from - w, end - w) });
      break;
    }
    case 'custom':
      break;
  }
  return ops;
}

/** True when a text layer's `row` follows the timeline (a 0 -> 1 ramp). */
export function readFollow(project: Project, layerId: string): boolean | 'custom' {
  const p = project.parameters[`${layerParamPrefix(layerId)}row`];
  if (!p) return false;
  const r = rampOf(p);
  return r && r.from === 0 && r.to === 1 ? true : 'custom';
}

/** Ops that make a text layer follow the timeline (`row` ramps 0 -> 1), or stop. */
export function followOps(project: Project, layerId: string, on: boolean): PatchOp[] {
  const id = `${layerParamPrefix(layerId)}row`;
  if (on) return [{ op: 'set', path: paramPath(id), value: { modulator: { kind: 'ramp', enabled: true, from: 0, to: 1, easing: 'linear' } } }];
  return project.parameters[id] ? [{ op: 'remove', path: paramPath(id) }] : [];
}

/** Lowest and highest value a modulated parameter reaches from `base` (switched off: base). */
function extent(base: number, p: Parameter | undefined): [number, number] {
  const m = p?.modulator;
  if (!m || !m.enabled) return [base, base];
  switch (m.kind) {
    case 'ramp':
      return [Math.min(m.from, m.to), Math.max(m.from, m.to)];
    case 'keyframes': {
      const values = m.keys.map((k) => k.value);
      return values.length > 0 ? [Math.min(...values), Math.max(...values)] : [base, base];
    }
    case 'lfo':
    case 'noise':
      return [base - Math.abs(m.amount), base + Math.abs(m.amount)];
  }
}

/**
 * Every row a layer shows over its animation, as fractions [lo, hi] clamped to 0..1: the
 * lowest rows start and the highest rows end its modulators reach (its base range when it
 * has none). Instancer axes with span 'full' are laid out over these rows.
 */
export function rowsSpan(project: Project, layer: LayerConfig): [number, number] | null {
  if (!('rows' in layer)) return null;
  const prefix = layerParamPrefix(layer.id);
  const [lo] = extent(layer.rows[0], project.parameters[`${prefix}rows.0`]);
  const [, hi] = extent(layer.rows[1], project.parameters[`${prefix}rows.1`]);
  return [Math.min(Math.max(lo, 0), 1), Math.min(Math.max(hi, 0), 1)];
}
