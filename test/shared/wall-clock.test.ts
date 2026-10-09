import { describe, expect, it } from 'vitest';
import { WallClock } from '../../src/shared/modulators.ts';

/** A page's two clocks: perf (monotonic, stops during sleep) and the system clock. */
function clocks(perfStart: number, systemStart: number) {
  const c = { perf: perfStart, system: systemStart };
  return {
    c,
    clock: new WallClock(
      () => c.perf,
      () => c.system,
    ),
    advance(ms: number) {
      c.perf += ms;
      c.system += ms;
    },
    sleep(ms: number) {
      c.system += ms; // performance.now() does not move while suspended
    },
  };
}

describe('WallClock', () => {
  it('reads the system time, at sub-millisecond resolution between checks', () => {
    const p = clocks(1000, 1_791_457_234_000);
    expect(p.clock.read()).toBe(1_791_457_234_000);
    p.advance(0.25);
    expect(p.clock.read()).toBeCloseTo(1_791_457_234_000.25, 6);
  });

  it('a window open across a sleep agrees with one opened after it', () => {
    const before = clocks(5_000, 1_791_457_000_000);
    before.clock.read();
    before.advance(2_000);
    before.sleep(5 * 3600_000); // five hours asleep
    before.advance(1_500); // past the next check: the jump is taken at once
    const after = clocks(10, before.c.system); // a window opened now
    expect(before.clock.read()).toBeCloseTo(after.clock.read(), 3);
  });

  it('eases small differences in rather than jumping', () => {
    const p = clocks(0, 1_791_457_000_000);
    const t0 = p.clock.read();
    p.advance(1_200);
    p.c.system += 40; // the system clock moved 40 ms more than performance.now()
    const t1 = p.clock.read();
    expect(t1 - t0).toBeGreaterThan(1_200);
    expect(t1 - t0).toBeLessThan(1_240); // only part of it at once
    for (let i = 0; i < 40; i++) {
      p.advance(1_000);
      p.clock.read();
    }
    expect(p.clock.read() - p.c.system).toBeCloseTo(0, 1); // caught up
  });
});
