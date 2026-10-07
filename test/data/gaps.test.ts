import { describe, expect, it } from 'vitest';
import { detectCadence } from '../../src/data/gaps.ts';

const DAY = 86_400_000;

describe('detectCadence', () => {
  it('finds the step, gaps and missing steps', () => {
    const v = Float64Array.from([0, 1, 2, 5, 6, 7, 10.4].map((d) => d * DAY));
    const c = detectCadence(v);
    expect(c.step).toBe(DAY);
    expect(c.nonMonotonic).toBe(0);
    expect(c.gaps).toEqual([
      { index: 3, from: 2 * DAY, to: 5 * DAY, missingSteps: 2 },
      { index: 6, from: 7 * DAY, to: 10.4 * DAY, missingSteps: 2 },
    ]);
  });

  it('skips NaN rows and does not count them as gaps', () => {
    const v = Float64Array.from([0, NaN, 1, 2, NaN, NaN, 3, 6]);
    const c = detectCadence(v);
    expect(c.step).toBe(1);
    expect(c.gaps).toEqual([{ index: 7, from: 3, to: 6, missingSteps: 2 }]);
  });

  it('counts non-increasing deltas', () => {
    const c = detectCadence(Float64Array.from([1, 2, 2, 3, 1, 4, 5]));
    expect(c.nonMonotonic).toBe(2);
    expect(c.step).toBe(1);
  });

  it('uses the median of positive deltas (even count averages the middle pair)', () => {
    expect(detectCadence(Float64Array.from([0, 1, 3, 6, 10])).step).toBe(2.5);
  });

  it('does not treat a ±1 h daylight-saving shift as a gap', () => {
    const h = 3_600_000;
    const v = Float64Array.from([0, DAY, 2 * DAY - h, 3 * DAY - h, 4 * DAY]);
    const c = detectCadence(v);
    expect(c.step).toBe(DAY);
    expect(c.gaps).toEqual([]);
  });

  it('returns NaN step and no gaps when there are no positive deltas', () => {
    for (const v of [new Float64Array(0), Float64Array.from([5]), Float64Array.from([NaN, NaN]), Float64Array.from([3, 3])]) {
      const c = detectCadence(v);
      expect(c.step).toBeNaN();
      expect(c.gaps).toEqual([]);
    }
    expect(detectCadence(Float64Array.from([3, 3])).nonMonotonic).toBe(1);
  });

  it('does not modify its input', () => {
    const v = Float64Array.from([5, 1, 3]);
    detectCadence(v);
    expect(Array.from(v)).toEqual([5, 1, 3]);
  });
});
