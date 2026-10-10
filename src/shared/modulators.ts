import { z } from 'zod';

/**
 * Modulators and the timeline transport. Pure and shared: the output evaluates them every
 * frame, the control window evaluates them to show live values.
 *
 * Time model (frame-rate independent, no drift, no float precision loss):
 *  - Every value is a function of absolute wall-clock time (`wallMs()`, epoch ms), never of
 *    accumulated frame deltas. All windows on the machine therefore agree, and a dropped
 *    frame changes nothing. See WallClock for how that time is kept in step across windows.
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
 * Phase at wall time T while playing: anchorPhase + (T - anchorWallMs) / duration, where the
 * duration is the whole transport cycle (see transportSeconds: a timeline with a gap before
 * restart stores its position through pass and gap, not the playhead's progress).
 */
export const TransportSchema = z.object({
  playing: z.boolean(),
  anchorWallMs: z.number(),
  anchorPhase: z.number().min(0).max(1),
});
export type Transport = z.infer<typeof TransportSchema>;

/**
 * A free-running clock in seconds (live session state, persisted like the transports). The
 * camera's LFO and noise modulators run on one (session.cameraClock) instead of the wall
 * clock, so its moves can be paused, jogged and reset. Time at wall time T while playing:
 * anchorSeconds + (T - anchorWallMs) / 1000. It never wraps, so noise never jumps.
 * WALL_CLOCK ({ playing, 0, 0 }) reads exactly as the wall clock.
 */
export const ClockSchema = z.object({
  playing: z.boolean(),
  anchorWallMs: z.number(),
  anchorSeconds: z.number(),
});
export type Clock = z.infer<typeof ClockSchema>;

/** A clock that reads as the wall clock (what camera moves ran on before they had a clock). */
export const WALL_CLOCK: Clock = { playing: true, anchorWallMs: 0, anchorSeconds: 0 };

/** The clock's time in ms at wall time `nowMs` (what modulators take as their time). */
export function clockMs(c: Clock, nowMs: number): number {
  return c.anchorSeconds * 1000 + (c.playing ? nowMs - c.anchorWallMs : 0);
}

/** Clock that keeps its time but starts or stops. */
export function setClockPlaying(c: Clock, playing: boolean, nowMs: number): Clock {
  return { playing, anchorWallMs: nowMs, anchorSeconds: clockMs(c, nowMs) / 1000 };
}

/** Clock moved to `seconds`, keeping play state. */
export function seekClock(c: Clock, seconds: number, nowMs: number): Clock {
  return { playing: c.playing, anchorWallMs: nowMs, anchorSeconds: Number.isFinite(seconds) ? seconds : 0 };
}

/**
 * Wall-clock ms for a high-resolution `performance.now()` reading: perfNow + an offset kept
 * in step with the system clock (`Date.now()`).
 *
 * Why not just `performance.timeOrigin + performance.now()`: on Linux, Chrome's
 * performance.now() is a monotonic clock that stops while the machine sleeps, and
 * timeOrigin is fixed when the page loads. A window that was open across a suspend then runs
 * behind windows opened later by the whole sleep, so the output, the preview and the control
 * window disagree about the timeline (seen after the laptop slept for hours). The system
 * clock is shared by every window, so all of them agree again.
 *
 * The offset is re-measured at most once a second. A small difference (Date.now()'s coarse
 * resolution, slow clock drift) is eased in, so motion never jerks; a large one (waking from
 * sleep, the clock being set) is taken at once.
 */
export class WallClock {
  private offset = Number.NaN;
  private checkedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly systemNow: () => number = () => Date.now(),
  ) {}

  /** Wall-clock ms at high-resolution time `perfNow` (from the same clock as `now`). */
  at(perfNow: number): number {
    if (perfNow - this.checkedAt >= WallClock.CHECK_MS || Number.isNaN(this.offset)) {
      const now = this.now();
      this.checkedAt = now;
      const measured = this.systemNow() - now;
      const diff = measured - this.offset;
      if (Number.isNaN(this.offset) || Math.abs(diff) > WallClock.SNAP_MS) this.offset = measured;
      else this.offset += diff * WallClock.EASE;
    }
    return perfNow + this.offset;
  }

  /** Wall-clock ms now. */
  read(): number {
    return this.at(this.now());
  }

  static readonly CHECK_MS = 1000;
  /** Differences beyond this are a jump (resume, clock change), not drift. */
  static readonly SNAP_MS = 250;
  static readonly EASE = 0.2;
}

/** The page's clock (shared by everything in the page that needs wall-clock time). */
export const wallClock = new WallClock();

/** Wall-clock milliseconds with sub-millisecond resolution (see WallClock). */
export function wallMs(): number {
  return wallClock.read();
}

export function timelinePhase(t: Transport, durationSec: number, loop: boolean, nowMs: number): number {
  if (!t.playing) return t.anchorPhase;
  const p = t.anchorPhase + (nowMs - t.anchorWallMs) / 1000 / Math.max(durationSec, 0.001);
  if (loop) return p - Math.floor(p);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Transport that keeps the current phase but starts/stops playing (`durationSec`: transportSeconds). */
export function setPlaying(t: Transport, playing: boolean, durationSec: number, loop: boolean, nowMs: number): Transport {
  return { playing, anchorWallMs: nowMs, anchorPhase: timelinePhase(t, durationSec, loop, nowMs) };
}

/**
 * Playback modes (forward, reverse, ping-pong). The transport keeps the *progress* u through
 * one cycle, 0..1, exactly as above; a ping-pong cycle is there and back, so it lasts twice
 * the duration. The playhead that modulators see is derived from u:
 *   forward  u      reverse  1 - u      pingpong  0 -> 1 over the first half, 1 -> 0 over the second
 * A finished non-looping timeline therefore rests at 1 (forward) or 0 (reverse, ping-pong).
 *
 * Gap before restart (the project timeline only; a layer's own timeline has none). A *pass*
 * is the active part of a cycle: forward 0 -> 1, reverse 1 -> 0, ping-pong 0 -> 1 -> 0. A
 * looping timeline with a gap of g seconds holds the playhead at the pass's end value
 * (1 forward, 0 reverse and ping-pong) for g seconds after each pass, so a cycle lasts
 * cycleSeconds + g. The transport's anchorPhase is then the *position* c through that whole
 * cycle, pass and gap; progress is u = min(c / a, 1), where a = cycleSeconds / (cycleSeconds
 * + g) is the pass's share of the cycle. With no gap c = u exactly, so transports saved
 * before gaps existed mean the same. A non-looping timeline ignores the gap: its pass ends
 * and holds.
 */
export type PlaybackMode = 'forward' | 'reverse' | 'pingpong';
export interface TimelineSettings {
  duration: number;
  loop: boolean;
  playback: PlaybackMode;
  /** Seconds held at the end of each pass before a looping timeline restarts (absent = 0). */
  gap?: number;
}

/** Seconds per pass (the active part of a cycle): the duration, or twice it for ping-pong. */
export function cycleSeconds(tl: TimelineSettings): number {
  return tl.playback === 'pingpong' ? tl.duration * 2 : tl.duration;
}

/** Seconds of gap that apply: the gap while looping, otherwise 0. */
export function gapSeconds(tl: TimelineSettings): number {
  const g = tl.gap ?? 0;
  return tl.loop && g > 0 ? g : 0;
}

/** Seconds per transport cycle, pass plus gap (what setPlaying needs). */
export function transportSeconds(tl: TimelineSettings): number {
  return cycleSeconds(tl) + gapSeconds(tl);
}

/** The pass's share of a cycle, 0..1 (1 with no gap). */
function passShare(tl: TimelineSettings): number {
  const g = gapSeconds(tl);
  if (g === 0) return 1;
  const pass = Math.max(cycleSeconds(tl), 0.001);
  return pass / (pass + g);
}

/** The transport's position c through its whole cycle (pass and gap), 0..1, at `nowMs`. */
export function cyclePosition(t: Transport, tl: TimelineSettings, nowMs: number): number {
  return timelinePhase(t, transportSeconds(tl), tl.loop, nowMs);
}

/** Progress u through the pass at cycle position c; 1 throughout the gap. */
export function progressAtPosition(c: number, tl: TimelineSettings): number {
  const a = passShare(tl);
  if (a === 1) return c;
  return c >= a ? 1 : c / a;
}

/**
 * The cycle position that shows progress u: always in the pass, never in the gap (u = 1 is
 * the pass's last instant, where the gap begins).
 */
export function positionForProgress(u: number, tl: TimelineSettings): number {
  return Math.min(Math.max(u, 0), 1) * passShare(tl);
}

/** Seconds into the gap at cycle position c, or -1 while the pass runs (or there is no gap). */
export function gapElapsed(c: number, tl: TimelineSettings): number {
  const a = passShare(tl);
  if (a === 1 || c < a) return -1;
  return (c - a) * transportSeconds(tl);
}

/** The transport's progress u through its pass at `nowMs` (held at 1 through the gap). */
export function cycleProgress(t: Transport, tl: TimelineSettings, nowMs: number): number {
  return progressAtPosition(cyclePosition(t, tl, nowMs), tl);
}

/** The playhead (what modulators see) for progress u. */
export function playheadOf(u: number, playback: PlaybackMode): number {
  switch (playback) {
    case 'forward':
      return u;
    case 'reverse':
      return 1 - u;
    case 'pingpong':
      return u <= 0.5 ? u * 2 : 2 - u * 2;
  }
}

/** The playhead at `nowMs`. */
export function playhead(t: Transport, tl: TimelineSettings, nowMs: number): number {
  return playheadOf(cycleProgress(t, tl, nowMs), tl.playback);
}

/**
 * The progress that shows playhead `phase`. Ping-pong has two (going out and coming back):
 * the one on the leg that progress `currentU` is on, so a scrub keeps the direction.
 */
export function progressFor(phase: number, playback: PlaybackMode, currentU: number): number {
  const p = Math.min(Math.max(phase, 0), 1);
  switch (playback) {
    case 'forward':
      return p;
    case 'reverse':
      return 1 - p;
    case 'pingpong':
      return currentU > 0.5 ? 1 - p / 2 : p / 2;
  }
}

/**
 * Transport moved to progress `u` (scrub or restart), keeping play state. Pass the timeline
 * whenever it may have a gap, so u lands in the pass (positionForProgress); without it u is
 * stored as is, which is right only with no gap (and for u = 0, the start, always).
 */
export function seek(t: Transport, u: number, nowMs: number, tl?: TimelineSettings): Transport {
  const c = tl ? positionForProgress(u, tl) : Math.min(Math.max(u, 0), 1);
  return { playing: t.playing, anchorWallMs: nowMs, anchorPhase: c };
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
