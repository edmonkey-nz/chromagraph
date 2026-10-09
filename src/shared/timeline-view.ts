import type { LayerType } from './layer-schema.ts';
import { formatClock, formatValue, layerTransport, MAX_KEYS, paramPhase } from './modulation-helpers.ts';
import { cycleProgress, evaluate, keyframeValue, playheadOf, sortKeys, type Modulator, type Parameter, type TimelineSettings, type Transport } from './modulators.ts';
import { clampParam, layerParamPrefix, parameterDefs, readParam, type ParamDef } from './parameters.ts';
import type { PatchOp } from './patch.ts';
import type { Project, SyncDoc } from './project-schema.ts';

/**
 * The model behind the control window's Timeline tab: what to draw for the project timeline,
 * each layer (in stack order) and the camera, and the patch ops for editing keyframes and
 * ramps on it. Pure and DOM-free, so it is tested in Node.
 *
 * Each group of lanes is drawn against the timeline that drives it: x is the playhead phase
 * 0..1 of the project timeline, or of the layer's own timeline when it has one. Ramps and
 * keyframes are stored as phases, so a key sits at the same x whatever the duration.
 *
 * LFO and noise modulators are functions of wall-clock time, not of the timeline, so their
 * lanes carry no curve over phase: the view draws them as a free-running signal instead.
 */

/** Points sampled along a ramp or keyframe curve, phase 0..1. */
export const CURVE_SAMPLES = 128;

type Key = { at: number; value: number };

// ---- clocks ---------------------------------------------------------------------------------

/** Where a timeline's playhead is at one moment. */
export interface ClockState {
  /** The phase modulators see, 0..1. */
  playhead: number;
  /** Progress through the transport's cycle, 0..1 (a ping-pong cycle is there and back). */
  progress: number;
  /** Which way the playhead is moving: +1 towards 1, -1 towards 0. */
  direction: 1 | -1;
  playing: boolean;
  /** A non-looping timeline that has played to the end. */
  finished: boolean;
}

export function emptyClock(): ClockState {
  return { playhead: 0, progress: 0, direction: 1, playing: false, finished: false };
}

/** The clock of a timeline at `nowMs`. Writes into `out` when given (no allocation per frame). */
export function clockState(t: Transport, tl: TimelineSettings, nowMs: number, out: ClockState = emptyClock()): ClockState {
  const u = cycleProgress(t, tl, nowMs);
  out.progress = u;
  out.playhead = playheadOf(u, tl.playback);
  out.direction = tl.playback === 'reverse' || (tl.playback === 'pingpong' && u > 0.5) ? -1 : 1;
  out.playing = t.playing;
  out.finished = !tl.loop && u >= 1;
  return out;
}

/** "ping-pong" for display. */
export function playbackTitle(playback: TimelineSettings['playback']): string {
  return playback === 'pingpong' ? 'ping-pong' : playback;
}

/** Seconds for display: "4 s", "0.5 s", "2:30". */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return String(sec);
  if (sec >= 60) return formatClock(sec);
  return `${formatValue(sec)} s`;
}

/** "0:20 · ping-pong" (with "· once" when it does not loop). */
export function timelineSummary(tl: TimelineSettings): string {
  return `${formatClock(tl.duration)} · ${playbackTitle(tl.playback)}${tl.loop ? '' : ' · once'}`;
}

// ---- lanes and groups -----------------------------------------------------------------------

interface LaneCommon {
  /** Parameter id (`layer.<id>.opacity`, `camera.yaw`). */
  id: string;
  def: ParamDef;
  enabled: boolean;
  /** The parameter's base value (what LFO and noise swing around). */
  base: number;
  /** The modulator, with keyframes sorted (ready for `laneValue`). */
  modulator: Modulator;
  /** Value range drawn from the bottom (lo) to the top (hi) of the lane. */
  lo: number;
  hi: number;
  /** The modulated value when the view was built. */
  value: number;
}

/** A ramp or keyframes lane: a curve over the driving timeline's phase. */
export interface CurveLane extends LaneCommon {
  kind: 'ramp' | 'keyframes';
  /** Keyframes sorted by `at`; for a ramp, its two endpoints at 0 and 1. */
  keys: Key[];
  /** The curve at CURVE_SAMPLES evenly spaced phases 0..1, normalised to lo..hi (0 bottom, 1 top). */
  samples: Float32Array;
}

/** An LFO or noise lane: free-running (wall clock), drawn as a scope, not on the timeline. */
export interface WaveLane extends LaneCommon {
  kind: 'lfo' | 'noise';
  /** "LFO · sine · 4 s · ±20". */
  summary: string;
  /** Seconds of recent signal the scope shows. */
  windowSec: number;
}

export type Lane = CurveLane | WaveLane;

export interface TimelineGroup {
  /** The layer id, or "camera". */
  key: string;
  kind: 'layer' | 'camera';
  name: string;
  /** Stack position from 1, or 0 for the camera. */
  position: number;
  layerType: LayerType | null;
  enabled: boolean;
  /** True when the layer runs on its own timeline (else the project's drives it). */
  own: boolean;
  /** The timeline that drives this group's ramps and keyframes, and its transport. */
  settings: TimelineSettings;
  transport: Transport;
  clock: ClockState;
  lanes: Lane[];
  /** Parameters of this owner without a modulator yet (for "add lane"). */
  free: ParamDef[];
}

export interface TimelineView {
  project: { settings: TimelineSettings; transport: Transport; clock: ClockState };
  groups: TimelineGroup[];
}

/** The value a lane's parameter takes at `nowMs` with the driving playhead at `phase` (no allocation). */
export function laneValue(lane: Pick<LaneCommon, 'def' | 'modulator' | 'base'>, nowMs: number, phase: number): number {
  return clampParam(lane.def, evaluate(lane.modulator, lane.base, nowMs, phase));
}

/**
 * Redraw a curve lane against a fixed `lo..hi` (renormalising its samples in place), so a
 * key being dragged does not rescale the lane under the pointer.
 */
export function reframeLane(lane: CurveLane, lo: number, hi: number): void {
  if (lane.lo === lo && lane.hi === hi) return;
  const s = lane.samples;
  for (let i = 0; i < s.length; i++) s[i] = (lane.lo + s[i]! * (lane.hi - lane.lo) - lo) / (hi - lo);
  lane.lo = lo;
  lane.hi = hi;
}

/** Lane position 0..1 (bottom..top) of a value. */
export function normalise(lane: Pick<LaneCommon, 'lo' | 'hi'>, v: number): number {
  return (v - lane.lo) / (lane.hi - lane.lo);
}

/** The value at lane position n (0 bottom, 1 top). */
export function denormalise(lane: Pick<LaneCommon, 'lo' | 'hi'>, n: number): number {
  return lane.lo + n * (lane.hi - lane.lo);
}

function sortedModulator(m: Modulator): Modulator {
  return m.kind === 'keyframes' ? { ...m, keys: sortKeys(m.keys) } : m;
}

/** lo..hi with some height, however flat the values are. */
function span(lo: number, hi: number, def: ParamDef): { lo: number; hi: number } {
  if (hi - lo > 1e-9) return { lo, hi };
  const pad = Math.max(Math.abs(def.max - def.min) * 0.05, Math.abs(lo) * 0.05, 0.5);
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * How a curve lane is scaled vertically: to the parameter's slider range (widened to any
 * values outside it), or fitted to its own values, so small moves on a wide range show.
 */
export type LaneScale = 'slider' | 'fit';

/** Fitted lanes: padding above and below the values, as a fraction of their spread. */
export const FIT_PAD = 0.1;
/** Fitted lanes: the smallest span drawn, as a fraction of the slider range (so a flat lane stays flat). */
export const FIT_MIN_SPAN = 0.02;

/**
 * The value range a curve lane draws, given the lowest and highest value its keys and curve
 * reach. `slider`: the slider range, widened to the values. `fit`: the values with FIT_PAD
 * padding, at least FIT_MIN_SPAN of the slider range tall (2 for whole-number parameters),
 * kept inside the valid range where it can be, and rounded outwards to tidy numbers.
 */
export function laneRange(def: ParamDef, lo: number, hi: number, scale: LaneScale): { lo: number; hi: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return span(def.min, def.max, def);
  if (scale === 'slider') return span(Math.min(lo, def.min), Math.max(hi, def.max), def);
  const minSpan = Math.max(Math.abs(def.max - def.min) * FIT_MIN_SPAN, def.integer ? 2 : 0, Math.abs(lo + hi) * 1e-6, 1e-6);
  const spread = hi - lo;
  const pad = Math.max(spread * FIT_PAD, (minSpan - spread) / 2);
  let a = Math.max(lo - pad, def.hardMin);
  let b = Math.min(hi + pad, def.hardMax);
  // Clipped by the valid range: grow the other way instead, so the lane keeps its height.
  if (b - a < minSpan) {
    if (a <= def.hardMin) b = Math.min(a + minSpan, def.hardMax);
    else a = Math.max(b - minSpan, def.hardMin);
  }
  // Round outwards to two significant figures of the span, so the range reads "-200 – 410".
  if (b - a > 0) {
    const step = 10 ** (Math.floor(Math.log10(b - a)) - 1);
    const decimals = Math.min(Math.max(-Math.floor(Math.log10(step)), 0), 20);
    a = Math.max(Number((Math.floor(a / step) * step).toFixed(decimals)), def.hardMin);
    b = Math.min(Number((Math.ceil(b / step) * step).toFixed(decimals)), def.hardMax);
  }
  return span(a, b, def);
}

/** "LFO · sine · 4 s · ±20" or "Noise · 0.5/s · ±20". */
export function waveSummary(m: Extract<Modulator, { kind: 'lfo' | 'noise' }>): string {
  const amount = `±${formatValue(Math.abs(m.amount))}`;
  if (m.kind === 'lfo') return `LFO · ${m.shape} · ${formatSeconds(m.period)} · ${amount}`;
  return `Noise · ${formatValue(m.speed)}/s · ${amount}`;
}

/** Seconds of recent signal a scope shows: two LFO cycles, or about six noise values. */
export function waveWindow(m: Extract<Modulator, { kind: 'lfo' | 'noise' }>): number {
  const sec = m.kind === 'lfo' ? m.period * 2 : 6 / m.speed;
  return Math.min(Math.max(sec, 0.02), 600);
}

/** A lane for one modulated parameter, with its playhead at `phase` (curve lanes scaled by `scale`). */
export function buildLane(def: ParamDef, raw: Modulator, base: number, nowMs: number, phase: number, samples = CURVE_SAMPLES, scale: LaneScale = 'slider'): Lane {
  const modulator = sortedModulator(raw);
  const common = { id: def.id, def, enabled: modulator.enabled, base, modulator };
  const value = clampParam(def, evaluate(modulator, base, nowMs, phase));
  if (modulator.kind === 'lfo' || modulator.kind === 'noise') {
    const a = Math.abs(modulator.amount);
    const r = span(Math.max(base - a, def.hardMin), Math.min(base + a, def.hardMax), def);
    return { ...common, kind: modulator.kind, ...r, value, summary: waveSummary(modulator), windowSec: waveWindow(modulator) };
  }
  const keys =
    modulator.kind === 'keyframes'
      ? modulator.keys.map((k) => ({ at: k.at, value: k.value }))
      : [
          { at: 0, value: modulator.from },
          { at: 1, value: modulator.to },
        ];
  // The curve as the output computes it (ignoring `enabled`, so a switched-off lane still shows its shape).
  const on = { ...modulator, enabled: true };
  const n = Math.max(2, samples);
  const raws = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = clampParam(def, evaluate(on, base, nowMs, i / (n - 1)));
    raws[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (const k of keys) {
    if (k.value < lo) lo = k.value;
    if (k.value > hi) hi = k.value;
  }
  const r = laneRange(def, lo, hi, scale);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (raws[i]! - r.lo) / (r.hi - r.lo);
  return { ...common, kind: modulator.kind, ...r, value, keys, samples: out };
}

/**
 * Everything the Timeline tab draws at `nowMs`: the project clock, then one group per layer
 * in stack order, then the camera. Each group lists one lane per modulated parameter (in
 * the registry's order) and the parameters it could add a lane for. Curve lanes are scaled by
 * `scale` (see laneRange).
 */
export function timelineView(doc: SyncDoc, nowMs: number, samples = CURVE_SAMPLES, scale: LaneScale = 'slider'): TimelineView {
  const { project, session } = doc;
  const defs = parameterDefs(project);
  const params = project.parameters;
  const projectClock = clockState(session.transport, project.timeline, nowMs);

  const groupOf = (prefix: string, settings: TimelineSettings, transport: Transport) => {
    const clock = clockState(transport, settings, nowMs);
    const lanes: Lane[] = [];
    const free: ParamDef[] = [];
    for (const def of defs) {
      if (!def.id.startsWith(prefix)) continue;
      const p = params[def.id];
      if (!p) {
        free.push(def);
        continue;
      }
      const base = readParam(project, def.id) ?? def.min;
      lanes.push(buildLane(def, p.modulator, base, nowMs, clock.playhead, samples, scale));
    }
    return { settings, transport, clock, lanes, free };
  };

  const groups: TimelineGroup[] = project.layers.map((layer, i) => {
    const own = layer.timeline.own;
    const g = own
      ? groupOf(layerParamPrefix(layer.id), layer.timeline, layerTransport(session, layer.id))
      : groupOf(layerParamPrefix(layer.id), project.timeline, session.transport);
    return { key: layer.id, kind: 'layer', name: layer.name || layer.id, position: i + 1, layerType: layer.type, enabled: layer.enabled, own, ...g };
  });
  groups.push({
    key: 'camera',
    kind: 'camera',
    name: 'Camera',
    position: 0,
    layerType: null,
    enabled: true,
    own: false,
    ...groupOf('camera.', project.timeline, session.transport),
  });
  return { project: { settings: project.timeline, transport: session.transport, clock: projectClock }, groups };
}

// ---- edits ----------------------------------------------------------------------------------

const paramPath = (id: string) => ['project', 'parameters', id];

function defOf(project: Project, id: string): ParamDef | undefined {
  return parameterDefs(project).find((d) => d.id === id);
}

function setParam(id: string, modulator: Modulator): PatchOp[] {
  const value: Parameter = { modulator };
  return [{ op: 'set', path: paramPath(id), value }];
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0);

/** Keys sorted, with the index the key `moved` (by identity) ended up at. */
function sortTracking(keys: Key[], moved: Key): { keys: Key[]; index: number } {
  const sorted = sortKeys(keys);
  return { keys: sorted, index: sorted.indexOf(moved) };
}

/** A ramp as two keyframes with exactly the same curve (smooth easing = smooth interpolation). */
export function rampAsKeyframes(m: Extract<Modulator, { kind: 'ramp' }>): Extract<Modulator, { kind: 'keyframes' }> {
  return {
    kind: 'keyframes',
    enabled: m.enabled,
    keys: [
      { at: 0, value: m.from },
      { at: 1, value: m.to },
    ],
    interpolation: m.easing === 'smooth' ? 'smooth' : 'linear',
  };
}

/** The keyframes behind a lane: its own, a ramp converted, or null (LFO, noise, none). */
function asKeyframes(m: Modulator | undefined): Extract<Modulator, { kind: 'keyframes' }> | null {
  if (!m) return null;
  if (m.kind === 'keyframes') return { ...m, keys: sortKeys(m.keys).map((k) => ({ at: k.at, value: k.value })) };
  if (m.kind === 'ramp') return rampAsKeyframes(m);
  return null;
}

export interface KeyEdit {
  ops: PatchOp[];
  /** The edited key's index in the sorted keys after the edit (keys can pass each other). */
  index: number;
}

/**
 * Move keyframe `index` (in sorted order) to phase `at` and `value`, clamped to 0..1 and to
 * the parameter's valid range (rounded for whole-number parameters). Null when the
 * parameter has no keyframes or no such key.
 */
export function moveKeyOps(project: Project, paramId: string, index: number, at: number, value: number): KeyEdit | null {
  const m = project.parameters[paramId]?.modulator;
  const def = defOf(project, paramId);
  if (m?.kind !== 'keyframes' || !def) return null;
  const keys = sortKeys(m.keys).map((k) => ({ at: k.at, value: k.value }));
  const key = keys[index];
  if (!key) return null;
  key.at = clamp01(at);
  key.value = clampParam(def, value);
  const r = sortTracking(keys, key);
  return { ops: setParam(paramId, { ...m, keys: r.keys }), index: r.index };
}

/**
 * Add a keyframe at phase `at` with the value the curve has there, so the value at that
 * phase is unchanged (linear curves keep their whole shape; a smooth curve now eases into
 * and out of the new key). A ramp becomes keyframes first, with the same curve. Null for LFO, noise, a missing
 * modulator or 64 keys already. When a key is already at that phase, its index with no ops.
 */
export function addKeyOps(project: Project, paramId: string, at: number): KeyEdit | null {
  const km = asKeyframes(project.parameters[paramId]?.modulator);
  const def = defOf(project, paramId);
  if (!km || !def) return null;
  const p = clamp01(at);
  const near = km.keys.findIndex((k) => Math.abs(k.at - p) < 1e-4);
  if (near >= 0) return { ops: [], index: near };
  if (km.keys.length >= MAX_KEYS) return null;
  const key = { at: p, value: clampParam(def, keyframeValue(km.keys, km.interpolation, p)) };
  const r = sortTracking([...km.keys, key], key);
  return { ops: setParam(paramId, { ...km, keys: r.keys }), index: r.index };
}

/** Remove keyframe `index` (sorted order). Null when it is the only key, or there is no such key. */
export function deleteKeyOps(project: Project, paramId: string, index: number): PatchOp[] | null {
  const m = project.parameters[paramId]?.modulator;
  if (m?.kind !== 'keyframes' || m.keys.length <= 1) return null;
  const keys = sortKeys(m.keys).map((k) => ({ at: k.at, value: k.value }));
  if (index < 0 || index >= keys.length) return null;
  keys.splice(index, 1);
  return setParam(paramId, { ...m, keys });
}

/** Set a ramp's value at phase 0 (`from`) or 1 (`to`), clamped to the valid range. */
export function moveRampOps(project: Project, paramId: string, end: 'from' | 'to', value: number): PatchOp[] | null {
  const m = project.parameters[paramId]?.modulator;
  const def = defOf(project, paramId);
  if (m?.kind !== 'ramp' || !def) return null;
  return setParam(paramId, { ...m, [end]: clampParam(def, value) });
}

/**
 * "Key at playhead": a key at the parameter's current playhead (its layer's own timeline, or
 * the project's). With no modulator yet, a new keyframes modulator with that one key at the
 * base value; with keyframes (or a ramp, converted), a key with the curve's current value.
 * Null for LFO and noise (they don't run on the timeline) or an unknown parameter.
 */
export function keyAtPlayheadOps(doc: SyncDoc, paramId: string, nowMs: number): KeyEdit | null {
  const { project, session } = doc;
  const def = defOf(project, paramId);
  if (!def) return null;
  const phase = paramPhase(project, session, paramId, nowMs);
  const m = project.parameters[paramId]?.modulator;
  if (!m) {
    const base = clampParam(def, readParam(project, paramId) ?? def.min);
    return { ops: setParam(paramId, { kind: 'keyframes', enabled: true, keys: [{ at: clamp01(phase), value: base }], interpolation: 'linear' }), index: 0 };
  }
  return addKeyOps(project, paramId, phase);
}

/** Remove a parameter's modulator (its lane). */
export function removeLaneOps(paramId: string): PatchOp[] {
  return [{ op: 'remove', path: paramPath(paramId) }];
}

/** What to ask before removing a lane: “Remove the 3 keyframes on “opacity” (Rain)? …”. */
export function removeLaneQuestion(lane: Lane, owner: string): string {
  const n = lane.kind === 'keyframes' ? lane.keys.length : 0;
  const what = lane.kind === 'keyframes' ? `${n} keyframe${n === 1 ? '' : 's'}` : lane.kind === 'lfo' ? 'LFO' : lane.kind;
  return `Remove the ${what} on “${lane.def.label}” (${owner})? The parameter goes back to its base value.`;
}

/** A dragged phase without pixel noise: 5 decimals (under a second on a 24 h timeline). */
export function tidyPhase(p: number): number {
  return Math.round(p * 1e5) / 1e5;
}

/**
 * A dragged value without pixel noise: rounded to about 1/2000 of the lane's span, to a
 * whole number of decimals (whole numbers for a span of 2000 or more, 4 decimals for 0..1).
 */
export function tidyValue(v: number, span: number): number {
  if (!Number.isFinite(v) || !(span > 0)) return v;
  const decimals = Math.min(Math.max(Math.ceil(-Math.log10(span / 2000)), 0), 8);
  return Number(v.toFixed(decimals));
}

// ---- ruler ----------------------------------------------------------------------------------

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/**
 * Ruler tick spacing in seconds for a timeline of `durationSec` drawn `widthPx` wide: the
 * smallest "nice" step whose labels are at least `minPx` apart.
 */
export function tickStep(durationSec: number, widthPx: number, minPx = 64): number {
  const pxPerSec = widthPx / Math.max(durationSec, 1e-6);
  for (const s of TICK_STEPS) if (s * pxPerSec >= minPx) return s;
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** A ruler label at `sec`: "1:30" (or "0:01:30" when the total runs to hours), "2.5 s" for sub-second steps. */
export function formatTick(sec: number, step: number, totalSec: number): string {
  if (step < 1) return `${formatValue(Math.round(sec * 100) / 100)} s`;
  return formatClock(sec, totalSec);
}
