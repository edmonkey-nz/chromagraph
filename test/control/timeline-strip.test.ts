import { describe, expect, it } from 'vitest';
import {
  ECHO_WAIT_MS,
  StripTrack,
  STRIP_PAD_X,
  stripChip,
  stripDirection,
  stripPhase,
  stripPosition,
  stripX,
} from '../../src/client/control/timeline-strip.ts';
import { SCRUB_INTERVAL_MS } from '../../src/client/control/timeline-panel.ts';
import type { TimelineSettings, Transport } from '../../src/shared/modulators.ts';

const T0 = 1_791_457_234_694; // a real wall-clock time
const tl = (over: Partial<TimelineSettings> = {}): TimelineSettings => ({ duration: 60, loop: true, playback: 'forward', ...over });
const tp = (anchorPhase: number, playing = true, anchorWallMs = T0): Transport => ({ playing, anchorWallMs, anchorPhase });

describe('timeline strip geometry', () => {
  it('maps phase to x and back, inset from the ends', () => {
    expect(stripX(0, 400)).toBe(STRIP_PAD_X);
    expect(stripX(1, 400)).toBe(400 - STRIP_PAD_X);
    for (const p of [0, 0.25, 0.5, 0.9, 1]) expect(stripPhase(stripX(p, 400), 400)).toBeCloseTo(p);
  });

  it('clamps x beyond the ends and copes with a zero width', () => {
    expect(stripPhase(-50, 400)).toBe(0);
    expect(stripPhase(1000, 400)).toBe(1);
    expect(Number.isFinite(stripPhase(5, 0))).toBe(true);
  });
});

describe('timeline strip text', () => {
  it('shows position and duration as the Timeline tab does', () => {
    expect(stripPosition(22 / 60, tl(), 1)).toBe('0:22 / 1:00');
    expect(stripPosition(0.5, tl({ duration: 7200 }), 1)).toBe('1:00:00 / 2:00:00');
  });

  it('adds the direction for reverse and ping-pong only', () => {
    expect(stripPosition(0.5, tl({ playback: 'reverse' }), -1)).toBe('0:30 / 1:00 ◂');
    expect(stripPosition(0.5, tl({ playback: 'pingpong' }), 1)).toBe('0:30 / 1:00 ▸');
    expect(stripPosition(0.5, tl({ playback: 'pingpong' }), -1)).toBe('0:30 / 1:00 ◂');
  });

  it('labels the playback mode and looping', () => {
    expect(stripChip(tl())).toBe('forward · loop');
    expect(stripChip(tl({ playback: 'pingpong', loop: false }))).toBe('ping-pong · once');
  });

  it('knows which way the playhead runs', () => {
    expect(stripDirection(tl(), 0.7)).toBe(1);
    expect(stripDirection(tl({ playback: 'reverse' }), 0.2)).toBe(-1);
    expect(stripDirection(tl({ playback: 'pingpong' }), 0.3)).toBe(1);
    expect(stripDirection(tl({ playback: 'pingpong' }), 0.7)).toBe(-1);
  });
});

describe('timeline strip transport', () => {
  it('follows the synced transport', () => {
    const k = new StripTrack();
    const a = tp(0.1);
    k.sync(a, T0);
    expect(k.local).toBe(a);
    const b = tp(0.2);
    k.sync(b, T0 + 10);
    expect(k.local).toBe(b);
  });

  it('ignores incoming transports while the ruler is dragged', () => {
    const k = new StripTrack();
    k.sync(tp(0.1), T0);
    k.scrubbing = true;
    const mine = tp(0.6);
    k.set(mine, false, T0 + 5);
    k.sync(tp(0.3), T0 + 10);
    expect(k.local).toBe(mine);
  });

  it('after a send, ignores stale echoes until its own arrives', () => {
    const k = new StripTrack();
    k.sync(tp(0.1), T0);
    k.scrubbing = true;
    k.set(tp(0.3, true, T0 + 10), true, T0 + 10);
    k.set(tp(0.5, true, T0 + 70), true, T0 + 70);
    k.scrubbing = false;
    // The echo of the first seek comes after the drag ended: it must not pull the playhead back.
    k.sync(tp(0.3, true, T0 + 10), T0 + 80);
    expect(k.local?.anchorPhase).toBe(0.5);
    const echo = tp(0.5, true, T0 + 70);
    k.sync(echo, T0 + 90);
    expect(k.local).toBe(echo);
    // Then other changes come through again.
    const other = tp(0.9);
    k.sync(other, T0 + 100);
    expect(k.local).toBe(other);
  });

  it('gives up waiting for an echo that never comes', () => {
    const k = new StripTrack();
    const synced = tp(0.1);
    k.sync(synced, T0);
    k.set(tp(0.4), true, T0 + 10);
    k.settle(T0 + 10 + ECHO_WAIT_MS - 1);
    expect(k.local?.anchorPhase).toBe(0.4);
    k.settle(T0 + 10 + ECHO_WAIT_MS);
    expect(k.local).toBe(synced);
  });

  it('accepts someone else’s change once the wait is over', () => {
    const k = new StripTrack();
    k.sync(tp(0.1), T0);
    k.set(tp(0.4), true, T0);
    const other = tp(0.8);
    k.sync(other, T0 + ECHO_WAIT_MS + 1);
    expect(k.local).toBe(other);
  });

  it('throttles scrub sends to one per interval', () => {
    const k = new StripTrack();
    expect(k.due(T0)).toBe(true);
    k.set(tp(0.2), true, T0);
    expect(k.due(T0 + SCRUB_INTERVAL_MS - 1)).toBe(false);
    k.set(tp(0.25), false, T0 + 20); // a step shown but not sent doesn't reset the interval
    expect(k.due(T0 + SCRUB_INTERVAL_MS)).toBe(true);
  });
});
