import { describe, expect, it } from 'vitest';
import { outputFade, reanchor, type FadeTimeline } from '../../src/shared/modulation-helpers.ts';
import {
  cyclePosition,
  cycleProgress,
  gapElapsed,
  playhead,
  positionForProgress,
  seek,
  setPlaying,
  transportSeconds,
  type TimelineSettings,
} from '../../src/shared/modulators.ts';

const T0 = 1_791_457_234_694; // a real wall-clock time
const at = (s: number) => T0 + s * 1000;
const start = { playing: true, anchorWallMs: T0, anchorPhase: 0 };

/** A 10 s timeline with a 2 s gap (loops by default). */
const tl = (over: Partial<TimelineSettings> = {}): TimelineSettings => ({ duration: 10, loop: true, playback: 'forward', gap: 2, ...over });

describe('gap before restart', () => {
  it('holds the playhead at the end of each forward pass for the gap, then restarts', () => {
    const t = tl();
    expect(transportSeconds(t)).toBe(12);
    expect(playhead(start, t, at(5))).toBeCloseTo(0.5);
    expect(playhead(start, t, at(10))).toBeCloseTo(1);
    expect(playhead(start, t, at(11))).toBe(1);
    expect(playhead(start, t, at(11.99))).toBe(1);
    expect(playhead(start, t, at(12))).toBeCloseTo(0);
    expect(playhead(start, t, at(17))).toBeCloseTo(0.5);
    expect(gapElapsed(cyclePosition(start, t, at(11)), t)).toBeCloseTo(1);
    expect(gapElapsed(cyclePosition(start, t, at(5)), t)).toBe(-1);
  });

  it('holds at 0 after a reverse or ping-pong pass', () => {
    expect(playhead(start, tl({ playback: 'reverse' }), at(2))).toBeCloseTo(0.8);
    expect(playhead(start, tl({ playback: 'reverse' }), at(11))).toBe(0);
    expect(playhead(start, tl({ playback: 'reverse' }), at(12.5))).toBeCloseTo(0.95);
    const pp = tl({ playback: 'pingpong' }); // 20 s there and back, then 2 s of gap
    expect(transportSeconds(pp)).toBe(22);
    expect(playhead(start, pp, at(10))).toBeCloseTo(1);
    expect(playhead(start, pp, at(15))).toBeCloseTo(0.5);
    expect(playhead(start, pp, at(21))).toBe(0);
    expect(playhead(start, pp, at(23))).toBeCloseTo(0.1);
  });

  it('has no effect without loop or on a timeline without one (a layer’s own)', () => {
    const once = tl({ loop: false });
    expect(transportSeconds(once)).toBe(10);
    expect(playhead(start, once, at(5))).toBeCloseTo(0.5);
    expect(playhead(start, once, at(30))).toBe(1);
    const layer = { duration: 10, loop: true, playback: 'forward' as const };
    expect(playhead(start, layer, at(11))).toBeCloseTo(0.1);
    expect(gapElapsed(0.99, layer)).toBe(-1);
  });

  it('keeps going without drift for hours', () => {
    const t = tl();
    // 1000 whole cycles (12 s each) later, plus 3 s: 0.3 through the pass.
    expect(playhead(start, t, at(12_000 + 3))).toBeCloseTo(0.3, 9);
  });

  it('seeks into the pass, never into the gap', () => {
    const t = tl();
    for (const u of [0, 0.25, 0.5, 0.999]) {
      const s = seek(start, u, at(11), t);
      expect(gapElapsed(s.anchorPhase, t)).toBe(-1);
      expect(cycleProgress(s, t, at(11))).toBeCloseTo(u);
    }
    // The very end is the pass's last instant: the gap follows it in full.
    const end = seek(start, 1, at(0), t);
    expect(cycleProgress(end, t, at(1.9))).toBe(1);
    expect(cycleProgress(end, t, at(2.1))).toBeCloseTo(0.01);
    expect(positionForProgress(1, t)).toBeCloseTo(10 / 12);
  });

  it('pauses and resumes in the gap without losing the time already held', () => {
    const t = tl();
    const paused = setPlaying(start, false, transportSeconds(t), t.loop, at(11));
    expect(playhead(paused, t, at(500))).toBe(1);
    const resumed = setPlaying(paused, true, transportSeconds(t), t.loop, at(500));
    expect(playhead(resumed, t, at(500.9))).toBe(1);
    expect(playhead(resumed, t, at(501.5))).toBeCloseTo(0.05);
  });
});

describe('re-anchoring with a gap', () => {
  const now = at(5); // halfway through the pass

  it('keeps the progress when the gap changes in the pass', () => {
    for (const gap of [0, 0.5, 5]) {
      const r = reanchor(start, tl(), tl({ gap }), now);
      expect(playhead(r, tl({ gap }), now)).toBeCloseTo(0.5);
      expect(playhead(r, tl({ gap }), now + 2500)).toBeCloseTo(0.75);
    }
  });

  it('keeps the progress when duration, loop or playback change with a gap', () => {
    const d = reanchor(start, tl(), tl({ duration: 100 }), now);
    expect(playhead(d, tl({ duration: 100 }), now)).toBeCloseTo(0.5);
    const l = reanchor(start, tl(), tl({ loop: false }), now);
    expect(playhead(l, tl({ loop: false }), now)).toBeCloseTo(0.5);
    const back = reanchor(l, tl({ loop: false }), tl(), now);
    expect(playhead(back, tl(), now)).toBeCloseTo(0.5);
    const r = reanchor(start, tl(), tl({ playback: 'reverse' }), now);
    expect(playhead(r, tl({ playback: 'reverse' }), now)).toBeCloseTo(0.5);
    const p = reanchor(start, tl({ gap: 0 }), tl({ playback: 'pingpong' }), at(3));
    expect(playhead(p, tl({ playback: 'pingpong' }), at(3))).toBeCloseTo(0.3);
  });

  it('stays in the gap with the seconds already held when settings change there', () => {
    const inGap = at(11); // 1 s into a 2 s gap
    const longer = reanchor(start, tl(), tl({ gap: 4 }), inGap);
    expect(playhead(longer, tl({ gap: 4 }), inGap)).toBe(1);
    expect(gapElapsed(cyclePosition(longer, tl({ gap: 4 }), inGap), tl({ gap: 4 }))).toBeCloseTo(1);
    expect(playhead(longer, tl({ gap: 4 }), inGap + 2900)).toBe(1);
    expect(playhead(longer, tl({ gap: 4 }), inGap + 3500)).toBeCloseTo(0.05);
    // A new duration: still 1 s into the gap, then the longer pass.
    const dur = reanchor(start, tl(), tl({ duration: 60 }), inGap);
    expect(playhead(dur, tl({ duration: 60 }), inGap + 900)).toBe(1);
    expect(playhead(dur, tl({ duration: 60 }), inGap + 1600)).toBeCloseTo(0.6 / 60);
    // Fade settings alone leave the transport where it is.
    const fades = reanchor(start, tl(), { ...tl(), fadeIn: true } as TimelineSettings, inGap);
    expect(cyclePosition(fades, tl(), inGap)).toBeCloseTo(cyclePosition(start, tl(), inGap));
  });

  it('ends the gap now when it is shortened below the time held, or removed', () => {
    const inGap = at(11);
    const shorter = reanchor(start, tl(), tl({ gap: 0.5 }), inGap);
    expect(playhead(shorter, tl({ gap: 0.5 }), inGap)).toBe(0);
    expect(playhead(shorter, tl({ gap: 0.5 }), inGap + 1000)).toBeCloseTo(0.1);
    const none = reanchor(start, tl(), tl({ gap: 0 }), inGap);
    expect(playhead(none, tl({ gap: 0 }), inGap + 1000)).toBeCloseTo(0.1);
    // Not looping any more: it rests at the end instead.
    const once = reanchor(start, tl(), tl({ loop: false }), inGap);
    expect(playhead(once, tl({ loop: false }), inGap + 5000)).toBe(1);
  });

  it('continues from the held playhead when the playback mode changes in the gap', () => {
    const inGap = at(11); // forward, held at 1
    const r = reanchor(start, tl(), tl({ playback: 'reverse' }), inGap);
    expect(playhead(r, tl({ playback: 'reverse' }), inGap)).toBeCloseTo(1);
    expect(playhead(r, tl({ playback: 'reverse' }), inGap + 1000)).toBeCloseTo(0.9);
  });
});

describe('output fade', () => {
  const fade = (over: Partial<FadeTimeline> = {}): FadeTimeline => ({
    duration: 10,
    loop: true,
    playback: 'forward',
    gap: 2,
    fadeIn: true,
    fadeOut: true,
    fadeLength: 2,
    ...over,
  });
  const f = (tlf: FadeTimeline, s: number, t = start) => outputFade(tlf, t, at(s));

  it('is 1 throughout with neither fade', () => {
    const off = fade({ fadeIn: false, fadeOut: false });
    for (const s of [0, 1, 9.5, 11, 13]) expect(f(off, s)).toBe(1);
  });

  it('eases in over the start of the pass and out before the end, then holds the background in the gap', () => {
    const t = fade();
    expect(f(t, 0)).toBe(0);
    expect(f(t, 0.5)).toBeCloseTo(0.15625); // smoothstep(0.25)
    expect(f(t, 1)).toBeCloseTo(0.5);
    expect(f(t, 2)).toBe(1);
    expect(f(t, 5)).toBe(1);
    expect(f(t, 8)).toBe(1);
    expect(f(t, 9)).toBeCloseTo(0.5);
    expect(f(t, 9.5)).toBeCloseTo(0.15625);
    expect(f(t, 10)).toBe(0);
    expect(f(t, 11)).toBe(0); // in the gap
    expect(f(t, 12)).toBe(0); // the next pass starts dark...
    expect(f(t, 13)).toBeCloseTo(0.5); // ...and fades in again
  });

  it('is smooth: no step anywhere in the cycle', () => {
    const t = fade();
    let prev = f(t, 0);
    for (let s = 0.01; s < 24; s += 0.01) {
      const v = f(t, s);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      prev = v;
    }
  });

  it('fade in only: full brightness through the end and the gap; fade out only: full at the start', () => {
    const inOnly = fade({ fadeOut: false });
    expect(f(inOnly, 9.9)).toBe(1);
    expect(f(inOnly, 11)).toBe(1);
    expect(f(inOnly, 12)).toBe(0);
    const outOnly = fade({ fadeIn: false });
    expect(f(outOnly, 0)).toBe(1);
    expect(f(outOnly, 9)).toBeCloseTo(0.5);
    expect(f(outOnly, 11)).toBe(0);
    expect(f(outOnly, 12)).toBe(1); // a cut back in after the gap
  });

  it('follows the pass in reverse and ping-pong (whole cycle, not each leg)', () => {
    const rev = fade({ playback: 'reverse' });
    expect(f(rev, 1)).toBeCloseTo(0.5);
    expect(f(rev, 5)).toBe(1);
    expect(f(rev, 9)).toBeCloseTo(0.5);
    expect(f(rev, 11)).toBe(0);
    const pp = fade({ playback: 'pingpong' }); // 20 s pass, 2 s gap
    expect(f(pp, 1)).toBeCloseTo(0.5);
    expect(f(pp, 10)).toBe(1); // the turn at 1 does not fade
    expect(f(pp, 19)).toBeCloseTo(0.5);
    expect(f(pp, 21)).toBe(0);
    expect(f(pp, 23)).toBeCloseTo(0.5);
  });

  it('clamps the fade length to half the pass', () => {
    const t = fade({ duration: 4, fadeLength: 10 }); // fades of 2 s each
    expect(f(t, 1)).toBeCloseTo(0.5);
    expect(f(t, 2)).toBe(1);
    expect(f(t, 3)).toBeCloseTo(0.5);
    expect(f(t, 4)).toBe(0);
  });

  it('without loop: fades in once, and stays out after the end with fade out', () => {
    const once = fade({ loop: false });
    expect(f(once, 1)).toBeCloseTo(0.5);
    expect(f(once, 9)).toBeCloseTo(0.5);
    expect(f(once, 10)).toBe(0);
    expect(f(once, 60)).toBe(0);
    expect(f(fade({ loop: false, fadeOut: false }), 60)).toBe(1);
  });

  it('a paused transport holds its fade', () => {
    const t = fade();
    const paused = setPlaying(start, false, transportSeconds(t), true, at(9));
    expect(outputFade(t, paused, at(1000))).toBeCloseTo(0.5);
  });

  it('without a gap, fade out then fade in dips through the background at the restart', () => {
    const t = fade({ gap: 0 });
    expect(f(t, 9)).toBeCloseTo(0.5);
    expect(f(t, 10)).toBe(0);
    expect(f(t, 11)).toBeCloseTo(0.5);
  });
});
