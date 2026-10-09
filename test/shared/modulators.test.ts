import { describe, expect, it } from 'vitest';
import {
  cycleProgress,
  playhead,
  progressFor,
  evaluate,
  keyframeValue,
  lfoWave,
  ModulatorSchema,
  seek,
  setPlaying,
  sortKeys,
  timelinePhase,
  valueNoise,
  type Modulator,
} from '../../src/shared/modulators.ts';

const lfo = (over: Partial<Extract<Modulator, { kind: 'lfo' }>> = {}): Modulator => ({
  kind: 'lfo',
  enabled: true,
  shape: 'sine',
  period: 4,
  phase: 0,
  amount: 10,
  ...over,
});

const T0 = 1_791_000_000_000; // a 2026 wall-clock time in ms

describe('timeline', () => {
  const tr = { playing: true, anchorWallMs: T0, anchorPhase: 0 };

  it('advances with wall time and loops', () => {
    expect(timelinePhase(tr, 100, true, T0)).toBe(0);
    expect(timelinePhase(tr, 100, true, T0 + 25_000)).toBeCloseTo(0.25);
    expect(timelinePhase(tr, 100, true, T0 + 125_000)).toBeCloseTo(0.25);
    expect(timelinePhase(tr, 100, false, T0 + 125_000)).toBe(1);
  });

  it('pauses, resumes and seeks without jumping', () => {
    const paused = setPlaying(tr, false, 100, true, T0 + 30_000);
    expect(timelinePhase(paused, 100, true, T0 + 90_000)).toBeCloseTo(0.3);
    const resumed = setPlaying(paused, true, 100, true, T0 + 90_000);
    expect(timelinePhase(resumed, 100, true, T0 + 100_000)).toBeCloseTo(0.4);
    const sought = seek(resumed, 0.8, T0 + 100_000);
    expect(timelinePhase(sought, 100, true, T0 + 110_000)).toBeCloseTo(0.9);
  });

  it('stays precise after days of running', () => {
    const days = 9 * 24 * 3600 * 1000;
    // 9 days at a 7 s duration: the phase is still exact to well under a frame.
    const p = timelinePhase(tr, 7, true, T0 + days + 3_500);
    expect(p).toBeCloseTo(((days / 1000 + 3.5) / 7) % 1, 9);
  });
});

describe('lfo', () => {
  it('waves around the base value', () => {
    expect(evaluate(lfo(), 100, T0 - (T0 % 4000), 0)).toBeCloseTo(100);
    expect(evaluate(lfo(), 100, T0 - (T0 % 4000) + 1000, 0)).toBeCloseTo(110);
    expect(evaluate(lfo({ enabled: false }), 100, T0 + 1000, 0)).toBe(100);
  });

  it('is a function of time only: same value however it is sampled', () => {
    const t = T0 + 123_456.789;
    expect(evaluate(lfo(), 0, t, 0)).toBe(evaluate(lfo(), 0, t, 0.7));
  });

  it('keeps full precision far from the epoch', () => {
    // A 0.5 s sine sampled a week later must still hit its peak exactly a quarter period in.
    const week = 7 * 24 * 3600 * 1000;
    const start = T0 + week - ((T0 + week) % 500);
    expect(evaluate(lfo({ period: 0.5 }), 0, start + 125, 0)).toBeCloseTo(10, 6);
  });

  it('has the expected shapes', () => {
    expect(lfoWave('triangle', 0.25)).toBe(1);
    expect(lfoWave('triangle', 0.75)).toBe(-1);
    expect(lfoWave('saw', 0)).toBe(-1);
    expect(lfoWave('square', 0.6)).toBe(-1);
  });
});

describe('noise', () => {
  it('is smooth, bounded and deterministic', () => {
    let prev = valueNoise(0, 1);
    for (let x = 0.01; x < 50; x += 0.01) {
      const v = valueNoise(x, 1);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
    expect(valueNoise(3.3, 7)).toBe(valueNoise(3.3, 7));
    expect(valueNoise(3.3, 7)).not.toBe(valueNoise(3.3, 8));
  });

  it('still varies at wall-clock magnitudes', () => {
    const x = (T0 / 1000) * 2;
    expect(valueNoise(x, 1)).not.toBe(valueNoise(x + 0.5, 1));
  });
});

describe('ramp and keyframes', () => {
  it('ramps from..to across the timeline', () => {
    const r: Modulator = { kind: 'ramp', enabled: true, from: 0, to: 1, easing: 'linear' };
    expect(evaluate(r, 99, T0, 0.25)).toBe(0.25);
    expect(evaluate({ ...r, easing: 'smooth' }, 99, T0, 0.5)).toBe(0.5);
  });

  it('interpolates keys, holding before and after', () => {
    const keys = sortKeys([
      { at: 0.5, value: 10 },
      { at: 0.1, value: 0 },
      { at: 0.9, value: -10 },
    ]);
    expect(keyframeValue(keys, 'linear', 0)).toBe(0);
    expect(keyframeValue(keys, 'linear', 0.3)).toBeCloseTo(5);
    expect(keyframeValue(keys, 'step', 0.3)).toBe(0);
    expect(keyframeValue(keys, 'linear', 0.7)).toBeCloseTo(0);
    expect(keyframeValue(keys, 'linear', 1)).toBe(-10);
  });

  it('validates modulator shapes', () => {
    expect(ModulatorSchema.safeParse(lfo()).success).toBe(true);
    expect(ModulatorSchema.safeParse({ ...lfo(), period: 0 }).success).toBe(false);
    expect(ModulatorSchema.safeParse({ kind: 'keyframes', enabled: true, keys: [], interpolation: 'linear' }).success).toBe(false);
  });
});

describe('playback modes', () => {
  const T0 = 1_791_457_234_694;
  const tr = { playing: true, anchorWallMs: T0, anchorPhase: 0 };
  const at = (s: number) => T0 + s * 1000;

  it('forward and reverse run each way over the duration', () => {
    expect(playhead(tr, { duration: 100, loop: true, playback: 'forward' }, at(25))).toBeCloseTo(0.25);
    expect(playhead(tr, { duration: 100, loop: true, playback: 'reverse' }, at(25))).toBeCloseTo(0.75);
    expect(playhead(tr, { duration: 100, loop: true, playback: 'reverse' }, at(0))).toBe(1);
  });

  it('ping-pong goes out over one duration and back over the next', () => {
    const pp = { duration: 100, loop: true, playback: 'pingpong' as const };
    expect(playhead(tr, pp, at(25))).toBeCloseTo(0.25);
    expect(playhead(tr, pp, at(100))).toBeCloseTo(1);
    expect(playhead(tr, pp, at(125))).toBeCloseTo(0.75);
    expect(playhead(tr, pp, at(200))).toBeCloseTo(0);
    expect(playhead(tr, pp, at(225))).toBeCloseTo(0.25);
  });

  it('a finished one-shot rests at its end: 1 forward, 0 reverse and ping-pong', () => {
    expect(playhead(tr, { duration: 10, loop: false, playback: 'forward' }, at(99))).toBe(1);
    expect(playhead(tr, { duration: 10, loop: false, playback: 'reverse' }, at(99))).toBe(0);
    expect(playhead(tr, { duration: 10, loop: false, playback: 'pingpong' }, at(99))).toBe(0);
  });

  it('scrubbing a ping-pong keeps the leg it is on', () => {
    const pp = { duration: 100, loop: true, playback: 'pingpong' as const };
    const coming = cycleProgress(tr, pp, at(150)); // on the way back
    expect(progressFor(0.3, 'pingpong', coming)).toBeCloseTo(0.85);
    expect(progressFor(0.3, 'pingpong', 0.1)).toBeCloseTo(0.15);
    expect(progressFor(0.3, 'reverse', 0)).toBeCloseTo(0.7);
  });
});
