import { describe, expect, it } from 'vitest';
import {
  blurShows,
  chooseBlur,
  emptyBlurStep,
  emptyComposeLayer,
  emptyComposePlan,
  MAX_LEVEL,
  MAX_TAPS,
  needsCompose,
  offsetToUv,
  planCompose,
  type ComposeLayer,
} from '../../src/shared/compose-plan.ts';

const layer = (order: number, over: Partial<ComposeLayer> = {}): ComposeLayer => ({ ...emptyComposeLayer(), object: `L${order}`, order, ...over });
const plan = (layers: ComposeLayer[]) => planCompose(layers, layers.length, emptyComposePlan());
/** Segments as [first object .. last object, camera, kind] for readable expectations. */
const describePlan = (layers: ComposeLayer[]) => {
  const p = plan(layers);
  return p.segments.slice(0, p.segmentCount).map((s) => {
    const objects = p.sorted.slice(s.start, s.end).map((i) => layers[i]!.object);
    return `${objects.join(',')} ${s.screen ? 'screen' : 'camera'}${s.image ? ' image' : ''}`;
  });
};

describe('needsCompose', () => {
  it('is false when no layer has a shadow, a blur or the screen camera', () => {
    expect(needsCompose([layer(1), layer(2)], 2)).toBe(false);
    expect(needsCompose([], 0)).toBe(false);
  });

  it('is true for any of them, and only counts the first `count` layers', () => {
    expect(needsCompose([layer(1, { shadow: true })], 1)).toBe(true);
    expect(needsCompose([layer(1, { blur: true })], 1)).toBe(true);
    expect(needsCompose([layer(1, { screen: true })], 1)).toBe(true);
    expect(needsCompose([layer(1), layer(2, { blur: true })], 1)).toBe(false);
  });
});

describe('planCompose', () => {
  it('ordinary layers are one plain segment', () => {
    expect(describePlan([layer(100), layer(101), layer(102)])).toEqual(['L100,L101,L102 camera']);
  });

  it('sorts into stack order by renderOrder, keeping ties in scene order', () => {
    const a = layer(102);
    const b = layer(100, { object: 'B' });
    const c = layer(100, { object: 'C' });
    const d = layer(101, { screen: true });
    expect(describePlan([a, b, c, d])).toEqual(['B,C camera', 'L101 screen', 'L102 camera']);
  });

  it('a run of screen-fixed layers is drawn together with the screen camera', () => {
    const layers = [layer(100), layer(101, { screen: true }), layer(102, { screen: true }), layer(103)];
    expect(describePlan(layers)).toEqual(['L100 camera', 'L101,L102 screen', 'L103 camera']);
  });

  it('a shadowed or blurred layer gets its own image segment in its slot', () => {
    const layers = [layer(100), layer(101), layer(102, { shadow: true }), layer(103), layer(104, { blur: true, shadow: true }), layer(105, { blur: true })];
    expect(describePlan(layers)).toEqual(['L100,L101 camera', 'L102 camera image', 'L103 camera', 'L104 camera image', 'L105 camera image']);
  });

  it('a screen-fixed image layer keeps the screen camera', () => {
    expect(describePlan([layer(100), layer(101, { screen: true, shadow: true })])).toEqual(['L100 camera', 'L101 screen image']);
  });

  it('the test pattern (order 1e6) stays on top', () => {
    expect(describePlan([layer(1_000_000), layer(100, { blur: true }), layer(101)])).toEqual(['L100 camera image', 'L101,L1000000 camera']);
  });

  it('reuses its arrays from frame to frame', () => {
    const out = emptyComposePlan();
    planCompose([layer(1, { blur: true }), layer(2, { blur: true }), layer(3, { blur: true })], 3, out);
    const segments = out.segments;
    const first = segments[0];
    planCompose([layer(1), layer(2)], 2, out);
    expect(out.segments).toBe(segments);
    expect(out.segments[0]).toBe(first);
    expect(out.segmentCount).toBe(1);
    expect(out.count).toBe(2);
    expect(out.sorted.slice(0, 2)).toEqual([0, 1]);
  });

  it('plans nothing for no layers', () => {
    const p = plan([]);
    expect(p.segmentCount).toBe(0);
    expect(p.count).toBe(0);
  });
});

describe('chooseBlur', () => {
  const step = (px: number, scale = 1) => chooseBlur(px, scale, emptyBlurStep());

  it('no blur below a visible amount', () => {
    expect(step(0)).toEqual({ level: 0, sigma: 0, taps: 0 });
    expect(step(0.5)).toEqual({ level: 0, sigma: 0, taps: 0 });
    expect(step(Number.NaN).level).toBe(0);
    expect(step(-5).level).toBe(0);
  });

  it('small blurs run at half size', () => {
    const s = step(4); // sigma 2 px
    expect(s.level).toBe(1);
    // The 2x2 box already blurred by variance 3/12; the rest, in half-size texels.
    expect(s.sigma).toBeCloseTo(Math.sqrt(4 - 0.25) / 2, 6);
    expect(s.taps).toBe(Math.ceil(s.sigma * 3));
  });

  it('larger blurs move down the pyramid, never past its last level or the tap limit', () => {
    let previous = 0;
    for (const px of [8, 20, 40, 80, 100]) {
      const s = step(px);
      expect(s.level).toBeGreaterThanOrEqual(previous);
      expect(s.level).toBeLessThanOrEqual(MAX_LEVEL);
      expect(s.taps).toBeLessThanOrEqual(MAX_TAPS);
      previous = s.level;
    }
    expect(step(100).level).toBe(MAX_LEVEL);
  });

  it('the total blur matches the setting', () => {
    for (const px of [3, 10, 33, 64, 100]) {
      const s = step(px);
      const size = 2 ** s.level;
      const total = Math.sqrt((size * size - 1) / 12 + (s.sigma * size) ** 2);
      expect(total).toBeCloseTo(px / 2, 6);
    }
  });

  it('blurShows agrees with chooseBlur', () => {
    for (const px of [0, 0.5, 0.7, 1, 2, 50, Number.NaN]) {
      for (const scale of [1, 0.5]) expect(blurShows(px, scale)).toBe(step(px, scale).level > 0);
    }
  });

  it('scales with the image (the preview renders at half size)', () => {
    const full = step(40, 1);
    const half = step(40, 0.5);
    expect(half.level).toBe(full.level - 1);
  });
});

describe('offsetToUv', () => {
  it('converts output pixels to image uv (y up)', () => {
    expect(offsetToUv([192, -108], { x: 0, y: 0 })).toEqual({ x: 0.1, y: -0.1 });
  });

  it('ignores non-finite values', () => {
    expect(offsetToUv([Number.NaN, Infinity], { x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
  });
});
