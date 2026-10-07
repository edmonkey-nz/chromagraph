import { z } from 'zod';

/**
 * Modulators and the timeline transport. Pure and shared: the output evaluates them every
 * frame, the control window evaluates them to show live values.
 *
 * Time model (frame-rate independent, no drift, no float precision loss):
 *  - Every value is a function of absolute wall-clock time (`performance.timeOrigin +
 *    performance.now()`, in ms), never of accumulated frame deltas. All windows on the
 *    machine therefore agree, and a dropped frame changes nothing.
 *  - Periodic maths reduces time modulo the period in float64 before anything reaches
 *    float32, so hours or days of running lose no precision.
 *
 * How a modulator combines with the parameter's base value:
 *  - lfo, noise       base + amount * wave (wave in -1..1)
 *  - ramp, keyframes  replace the base value, driven by the timeline phase (0..1)
 * The result is then clamped to the parameter's valid range (see parameters.ts).
 */

export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'square'] as const;
export const EASINGS = ['linear', 'smooth'] as const;
export const INTERPOLATIONS = ['linear', 'smooth', 'step'] as const;

export const LfoSchema = z.object({
  kind: z.literal('lfo'),
  enabled: z.boolean(),
  shape: z.enum(LFO_SHAPES),
  /** Seconds per cycle. */
  period: z.number().min(0.01),
  /** Phase offset, 0..1 of a cycle. */
  phase: z.number().min(0).max(1),
  /** Peak deviation from the base value, in the parameter's units. */
  amount: z.number(),
});

export const NoiseSchema = z.object({
  kind: z.literal('noise'),
  enabled: z.boolean(),
  amount: z.number(),
  /** Roughly how many new values per second (smoothly interpolated). */
  speed: z.number().min(0.0001).max(100),
  seed: z.number().int(),
});

export const RampSchema = z.object({
  kind: z.literal('ramp'),
  enabled: z.boolean(),
  /** Value at timeline phase 0 and 1. */
  from: z.number(),
  to: z.number(),
  easing: z.enum(EASINGS),
});

export const KeyframesSchema = z.object({
  kind: z.literal('keyframes'),
  enabled: z.boolean(),
  /** Keys at timeline phases 0..1. Need not be sorted; before the first / after the last key the value holds. */
  keys: z
    .array(z.object({ at: z.number().min(0).max(1), value: z.number() }))
    .min(1)
    .max(64),
  interpolation: z.enum(INTERPOLATIONS),
});

export const ModulatorSchema = z.discriminatedUnion('kind', [LfoSchema, NoiseSchema, RampSchema, KeyframesSchema]);
export type Modulator = z.infer<typeof ModulatorSchema>;
export type ModulatorKind = Modulator['kind'];
export const MODULATOR_KINDS = ['lfo', 'noise', 'ramp', 'keyframes'] as const satisfies readonly ModulatorKind[];

/** project.parameters[paramId] — see parameters.ts for the id format. */
export const ParameterSchema = z.object({ modulator: ModulatorSchema });
export type Parameter = z.infer<typeof ParameterSchema>;

/**
 * Timeline transport (live session state, persisted by the server across restarts).
 * Phase at wall time T while playing: anchorPhase + (T - anchorWallMs) / duration.
 */
export const TransportSchema = z.object({
  playing: z.boolean(),
  anchorWallMs: z.number(),
  anchorPhase: z.number().min(0).max(1),
});
export type Transport = z.infer<typeof TransportSchema>;

/** Wall-clock milliseconds with sub-millisecond resolution, monotonic within a page. */
export function wallMs(): number {
  return performance.timeOrigin + performance.now();
}

export function timelinePhase(t: Transport, durationSec: number, loop: boolean, nowMs: number): number {
  if (!t.playing) return t.anchorPhase;
  const p = t.anchorPhase + (nowMs - t.anchorWallMs) / 1000 / Math.max(durationSec, 0.001);
  if (loop) return p - Math.floor(p);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Transport that keeps the current phase but starts/stops playing. */
export function setPlaying(t: Transport, playing: boolean, durationSec: number, loop: boolean, nowMs: number): Transport {
  return { playing, anchorWallMs: nowMs, anchorPhase: timelinePhase(t, durationSec, loop, nowMs) };
}

/** Transport moved to `phase` (scrub or restart), keeping play state. */
export function seek(t: Transport, phase: number, nowMs: number): Transport {
  return { playing: t.playing, anchorWallMs: nowMs, anchorPhase: Math.min(Math.max(phase, 0), 1) };
}

// ---- waveforms ---------------------------------------------------------------------

const TAU = Math.PI * 2;

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Periodic wave in -1..1 at cycle position f (0..1). */
export function lfoWave(shape: (typeof LFO_SHAPES)[number], f: number): number {
  switch (shape) {
    case 'sine':
      return Math.sin(f * TAU);
    case 'triangle':
      return f < 0.25 ? f * 4 : f < 0.75 ? 2 - f * 4 : f * 4 - 4;
    case 'saw':
      return f * 2 - 1;
    case 'square':
      return f < 0.5 ? 1 : -1;
  }
}

/** 32-bit integer hash (lowbias32). */
function hashInt(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Lattice value 0..1 for an integer index of any size up to 2^53 (hashed as two 32-bit halves). */
function lattice(i: number, seed: number): number {
  const lo = i >>> 0; // ToUint32: exact modulo 2^32 for any safe integer
  const hi = Math.floor(i / 4294967296);
  return hashInt(lo ^ hashInt(hi ^ seed)) / 4294967296;
}

/** Smooth 1D value noise in -1..1. */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = lattice(i, seed);
  const b = lattice(i + 1, seed);
  return (a + (b - a) * u) * 2 - 1;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Keyframe value at phase p. `keys` must be sorted by `at` (see sortKeys). */
export function keyframeValue(keys: readonly { at: number; value: number }[], interp: (typeof INTERPOLATIONS)[number], p: number): number {
  const first = keys[0]!;
  if (keys.length === 1 || p <= first.at) return first.value;
  const last = keys[keys.length - 1]!;
  if (p >= last.at) return last.value;
  let i = 1;
  while (i < keys.length && keys[i]!.at < p) i++;
  const a = keys[i - 1]!;
  const b = keys[i]!;
  if (interp === 'step') return a.value;
  const span = b.at - a.at;
  let t = span > 0 ? (p - a.at) / span : 1;
  if (interp === 'smooth') t = smoothstep(t);
  return a.value + (b.value - a.value) * t;
}

export function sortKeys<T extends { at: number }>(keys: readonly T[]): T[] {
  return [...keys].sort((a, b) => a.at - b.at);
}

/**
 * Modulated value. `nowMs` is wall-clock ms; `phase` is the timeline phase at that time.
 * Keyframes must already be sorted (callers compile once with sortKeys, not per frame).
 */
export function evaluate(m: Modulator, base: number, nowMs: number, phase: number): number {
  if (!m.enabled) return base;
  switch (m.kind) {
    case 'lfo': {
      // Reduce modulo the period in float64 before scaling.
      const periodMs = m.period * 1000;
      const f = fract((nowMs % periodMs) / periodMs + m.phase);
      return base + m.amount * lfoWave(m.shape, f);
    }
    case 'noise': {
      const x = (nowMs / 1000) * m.speed;
      return base + m.amount * valueNoise(x, m.seed);
    }
    case 'ramp': {
      const t = m.easing === 'smooth' ? smoothstep(phase) : phase;
      return m.from + (m.to - m.from) * t;
    }
    case 'keyframes':
      return keyframeValue(m.keys, m.interpolation, phase);
  }
}
