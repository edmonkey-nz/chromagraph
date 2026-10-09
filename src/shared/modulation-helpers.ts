import {
  cyclePosition,
  cycleSeconds,
  evaluate,
  gapElapsed,
  gapSeconds,
  keyframeValue,
  playhead,
  playheadOf,
  positionForProgress,
  progressAtPosition,
  progressFor,
  sortKeys,
  transportSeconds,
  type Modulator,
  type TimelineSettings,
  type ModulatorKind,
  type Parameter,
  type Transport,
} from './modulators.ts';
import { clampParam, layerParamPrefix, paramPatchPath, parameterDefs, readParam, type ParamDef } from './parameters.ts';
import type { PatchOp } from './patch.ts';
import type { LayerConfig } from './layer-schema.ts';
import type { Project, Session } from './project-schema.ts';

/**
 * Pure helpers for the control window's timeline and modulation panels: sensible defaults,
 * display formatting, and the patch ops for compound edits (data playhead, layer delete and
 * duplicate). No DOM, so they are tested in Node.
 */

export const MIN_DURATION = 1;
export const MAX_DURATION = 24 * 60 * 60;
export const MAX_KEYS = 64;

export function clampDuration(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_DURATION;
  return Math.min(Math.max(sec, MIN_DURATION), MAX_DURATION);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Clock display, "m:ss" or "h:mm:ss" (whole seconds, rounded down). Pass `scaleSec` (the
 * total) so a position shows hours whenever the total does: "0:03:25 / 1:00:00".
 */
export function formatClock(sec: number, scaleSec = sec): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0 || scaleSec >= 3600) return `${h}:${pad2(m)}:${pad2(ss)}`;
  return `${m}:${pad2(ss)}`;
}

/**
 * "3:25 / 10:00" for a phase 0..1 through a timeline of `durationSec`; "10:00 / 10:00 · gap"
 * while it holds in the gap before restart.
 */
export function formatPosition(phase: number, durationSec: number, inGap = false): string {
  return `${formatClock(phase * durationSec, durationSec)} / ${formatClock(durationSec)}${inGap ? ' · gap' : ''}`;
}

/** Compact number display: whole numbers for big values, a few decimals for small ones. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1 || a === 0) return String(Number(v.toFixed(3)));
  return String(Number(v.toPrecision(3)));
}

/** "Group · label", as listed in pickers and modulator folder titles. */
export function paramTitle(def: Pick<ParamDef, 'group' | 'label'>): string {
  return `${def.group} · ${def.label}`;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

/**
 * A new modulator of `kind` for a parameter, with defaults scaled to its UI range:
 *   lfo        sine, 4 s period, amount 10% of the range
 *   noise      amount 10% of the range, 0.5 values a second, random seed
 *   ramp       from the base value to the top of the range
 *   keyframes  two keys holding the base value
 */
export function defaultModulator(kind: ModulatorKind, def: Pick<ParamDef, 'min' | 'max'>, base: number, seed = randomSeed()): Modulator {
  const amount = (def.max - def.min) * 0.1;
  const b = Number.isFinite(base) ? base : def.min;
  switch (kind) {
    case 'lfo':
      return { kind, enabled: true, shape: 'sine', period: 4, phase: 0, amount };
    case 'noise':
      return { kind, enabled: true, amount, speed: 0.5, seed };
    case 'ramp':
      return { kind, enabled: true, from: b, to: def.max, easing: 'linear' };
    case 'keyframes':
      return {
        kind,
        enabled: true,
        keys: [
          { at: 0, value: b },
          { at: 1, value: b },
        ],
        interpolation: 'linear',
      };
  }
}

/** The project timeline's playhead at wall time `nowMs` (see playhead in modulators.ts). */
export function projectPhase(project: Pick<Project, 'timeline'>, transport: Transport, nowMs: number): number {
  return playhead(transport, project.timeline, nowMs);
}

/**
 * The transport that plays a layer's own timeline. A layer switched to its own timeline
 * without one yet (e.g. by going to a scene) plays with the project's transport.
 */
export function layerTransport(session: Pick<Session, 'transport' | 'layerTransports'>, layerId: string): Transport {
  return session.layerTransports[layerId] ?? session.transport;
}

/**
 * The timeline phase that drives a layer's ramps, keyframes and data playhead: its own
 * timeline's, or the project's when it has none (or the layer is unknown).
 */
export function layerPhase(
  project: Pick<Project, 'timeline' | 'layers'>,
  session: Pick<Session, 'transport' | 'layerTransports'>,
  layerId: string,
  nowMs: number,
): number {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer?.timeline.own) return projectPhase(project, session.transport, nowMs);
  return playhead(layerTransport(session, layerId), layer.timeline, nowMs);
}

/** The phase a parameter's modulators run on: its layer's own timeline, or the project's. */
export function paramPhase(
  project: Pick<Project, 'timeline' | 'layers'>,
  session: Pick<Session, 'transport' | 'layerTransports'>,
  paramId: string,
  nowMs: number,
): number {
  const m = /^layer\.([^.]+)\./.exec(paramId);
  return m ? layerPhase(project, session, m[1]!, nowMs) : projectPhase(project, session.transport, nowMs);
}

/**
 * Transport re-anchored for new timeline settings so the playhead does not jump: the same
 * progress when only the duration, loop or gap changes, the same playhead when the playback
 * mode changes (onto the outward leg of a ping-pong). In the gap before restart it stays in
 * the gap, keeping the seconds already held there; a gap shortened below those (or removed)
 * ends now, so the next pass starts (a non-looping timeline rests at its end instead).
 * Changing the playback mode in the gap continues from the held playhead without a gap.
 */
export function reanchor(transport: Transport, from: TimelineSettings, to: TimelineSettings, nowMs: number): Transport {
  const c = cyclePosition(transport, from, nowMs);
  const held = gapElapsed(c, from);
  let next: number;
  if (held >= 0 && from.playback === to.playback) {
    const g = gapSeconds(to);
    next = g > 0 ? (cycleSeconds(to) + Math.min(held, g)) / transportSeconds(to) : 1;
  } else {
    const u = progressAtPosition(c, from);
    next = positionForProgress(from.playback === to.playback ? u : progressFor(playheadOf(u, from.playback), to.playback, 0), to);
  }
  return { playing: transport.playing, anchorWallMs: nowMs, anchorPhase: Math.min(Math.max(next, 0), 1) };
}

/** What the output fade reads: the project timeline (a layer's own timeline has no fades). */
export type FadeTimeline = Pick<Project['timeline'], 'duration' | 'loop' | 'playback' | 'gap' | 'fadeIn' | 'fadeOut' | 'fadeLength'>;

/**
 * Whole-output brightness f, 0..1, for the project timeline at wall time `nowMs`: the output
 * mixes towards the background colour by 1 - f (stage.ts). Over one pass (forward 0 -> 1,
 * reverse 1 -> 0, ping-pong there and back), with x seconds into it:
 *   fadeIn   f eases 0 -> 1 over the first `fadeLength` s of the pass
 *   fadeOut  f eases 1 -> 0 over the last `fadeLength` s of the pass, before the gap
 *   gap      f = 0 with fadeOut (the background is held), else 1
 * `fadeLength` is clamped to half the pass so the two never overlap. A finished
 * non-looping timeline with fadeOut stays at 0. Both easings are smoothstep. A paused
 * transport holds whatever f it paused at (it is a function of the transport, like the
 * playhead). 1 when neither fade is on, which costs the output nothing.
 */
export function outputFade(tl: FadeTimeline, transport: Transport, nowMs: number): number {
  if (!tl.fadeIn && !tl.fadeOut) return 1;
  const pass = cycleSeconds(tl);
  const x = cyclePosition(transport, tl, nowMs) * transportSeconds(tl);
  if (x >= pass) return tl.fadeOut ? 0 : 1;
  const len = Math.min(tl.fadeLength, pass / 2);
  if (!(len > 0)) return 1;
  let f = 1;
  if (tl.fadeIn && x < len) f = smooth(x / len);
  if (tl.fadeOut && pass - x < len) f = Math.min(f, smooth((pass - x) / len));
  return f;
}

function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** The value a modulated parameter takes, as the output computes it (keyframes sorted here). */
export function modulatedValue(def: Pick<ParamDef, 'hardMin' | 'hardMax' | 'integer'>, m: Modulator, base: number, nowMs: number, phase: number): number {
  const sorted = m.kind === 'keyframes' ? { ...m, keys: sortKeys(m.keys) } : m;
  return clampParam(def, evaluate(sorted, base, nowMs, phase));
}

// ---- keyframes --------------------------------------------------------------------------

type Key = { at: number; value: number };

/**
 * Keys with one more added in the middle of the widest gap (including the gaps before the
 * first and after the last key), at the value the curve already has there. Unchanged at 64.
 */
export function addKeyframe(keys: readonly Key[]): Key[] {
  const sorted = sortKeys(keys);
  if (sorted.length >= MAX_KEYS) return sorted;
  if (sorted.length === 0) return [{ at: 0, value: 0 }];
  const edges = [0, ...sorted.map((k) => k.at), 1];
  let best = 0;
  let bestGap = -1;
  for (let i = 0; i < edges.length - 1; i++) {
    const gap = edges[i + 1]! - edges[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  const at = (edges[best]! + edges[best + 1]!) / 2;
  const value = keyframeValue(sorted, 'linear', at);
  return sortKeys([...sorted, { at, value }]);
}

/** Keys without the one at `index`; never removes the last remaining key. */
export function removeKeyframe(keys: readonly Key[], index: number): Key[] {
  if (keys.length <= 1 || index < 0 || index >= keys.length) return keys.slice();
  return keys.filter((_, i) => i !== index);
}

// ---- compound patches ---------------------------------------------------------------------

const paramPath = (id: string) => ['project', 'parameters', id];

/** `remove` ops for every modulator belonging to a layer (send with the layer's removal). */
export function layerParamRemovalOps(parameters: Readonly<Record<string, Parameter>>, layerId: string): PatchOp[] {
  const prefix = layerParamPrefix(layerId);
  return Object.keys(parameters)
    .filter((id) => id.startsWith(prefix))
    .map((id) => ({ op: 'remove', path: paramPath(id) }));
}

/** `set` ops copying a layer's modulators to another layer id (send with the duplicate). */
export function layerParamCopyOps(parameters: Readonly<Record<string, Parameter>>, fromId: string, toId: string): PatchOp[] {
  const from = layerParamPrefix(fromId);
  const to = layerParamPrefix(toId);
  const ops: PatchOp[] = [];
  for (const [id, p] of Object.entries(parameters)) {
    if (id.startsWith(from)) ops.push({ op: 'set', path: paramPath(to + id.slice(from.length)), value: structuredClone(p) });
  }
  return ops;
}

/** Parameter entries whose id no longer resolves (layer deleted, channel unmapped). */
export function orphanParamIds(project: Project, defs: readonly ParamDef[] = parameterDefs(project)): string[] {
  const known = new Set(defs.map((d) => d.id));
  return Object.keys(project.parameters).filter((id) => !known.has(id));
}

export const PLAYHEAD_MODES = ['reveal', 'window'] as const;
export type PlayheadMode = (typeof PLAYHEAD_MODES)[number];
export const MIN_WINDOW = 0.01;

function ramp(from: number, to: number): Parameter {
  return { modulator: { kind: 'ramp', enabled: true, from, to, easing: 'linear' } };
}

/**
 * How the data playhead drives a layer: `rows` (a row range to reveal or window through) for
 * every layer type with a row range (instancer, line, heat map, small multiples, hierarchy,
 * 3D surface); `row` (one current row to follow) for text layers. Null for a layer with
 * neither (a reflection plane), which the data playhead does not offer.
 */
export function playheadKind(layer: LayerConfig): 'rows' | 'row' | null {
  switch (layer.type) {
    case 'text':
      return 'row';
    case 'instancer':
    case 'line':
    case 'heatmap':
    case 'multiples':
    case 'hierarchy':
    case 'surface':
      return 'rows';
    case 'reflector':
      return null;
  }
}

/**
 * Ops for a "data playhead", driven by the timeline phase. On a layer with a row range:
 *   reveal  rows end ramps 0 -> 1; rows start goes back to a plain base of 0
 *   window  rows end ramps 0 -> 1 and rows start ramps -w -> 1 - w, so a window of width w
 *           sweeps through the rows (the output clamps the negative start to 0)
 * replacing any modulators already on the two row parameters. On a text layer ("follow
 * playhead") its `row` ramps 0 -> 1 and `mode` is ignored. Null if the layer is missing.
 */
export function dataPlayheadOps(project: Project, layerId: string, mode: PlayheadMode, width = 0.1): PatchOp[] | null {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return null;
  const kind = playheadKind(layer);
  if (kind === null) return null;
  if (kind === 'row') return [{ op: 'set', path: paramPath(`${layerParamPrefix(layerId)}row`), value: ramp(0, 1) }];
  const startId = `${layerParamPrefix(layerId)}rows.0`;
  const endId = `${layerParamPrefix(layerId)}rows.1`;
  const ops: PatchOp[] = [{ op: 'set', path: paramPath(endId), value: ramp(0, 1) }];
  if (mode === 'reveal') {
    ops.push({ op: 'remove', path: paramPath(startId) });
    const base = readParam(project, startId);
    const path = paramPatchPath(project, startId);
    if (base !== 0 && path) ops.push({ op: 'set', path, value: 0 });
  } else {
    const w = Math.min(Math.max(Number.isFinite(width) ? width : 0.1, MIN_WINDOW), 1);
    ops.push({ op: 'set', path: paramPath(startId), value: ramp(-w, 1 - w) });
  }
  return ops;
}
