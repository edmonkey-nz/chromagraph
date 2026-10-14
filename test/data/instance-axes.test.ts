import { describe, expect, it } from 'vitest';
import { axisTicks, layoutAxes, mapValue, tickDecimals, type AxesInput } from '../../src/data/instance-axes.ts';
import { buildInstanceData, resolveDomain } from '../../src/data/instance-data.ts';
import { DateLabels } from '../../src/data/instance-labels.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankInstancerLayer, defaultAxes, type InstancerLayer } from '../../src/shared/layer-schema.ts';

// The Blocks project's dataset: a quarter label (a category column) and a percentage. Values are
// float32 on their way to the GPU (16.2 is 16.2000005), hence 3-decimal comparisons of positions.
const CSV = `"Quarter","Gender pay gap"
"Jun-98",16.2
"Jun-99",15.2
"Jun-00",14
"Jun-01",13.1
"Jun-02",
"Jun-03",12.5
`;
const table = parseCsv(CSV).table;

/** A bar chart: 60 px per row from x = 100, baseline y = 140, height 0..500 px over 0..20. */
function bars(edit: (l: InstancerLayer) => void = () => {}): InstancerLayer {
  const l = blankInstancerLayer('ly', 'bars', 'ds');
  l.primitive = 'bar';
  l.origin = [100, 140, 0];
  l.step = [60, 0, 0];
  l.size = [40, 100, 40];
  l.channels.height = { ...l.channels.height, column: 'Gender pay gap', domain: [0, 20], range: [0, 500] };
  l.axes = defaultAxes();
  edit(l);
  return l;
}

function input(layer: InstancerLayer, first = 0, last = table.rowCount - 1): AxesInput {
  const data = buildInstanceData(layer, table, {}, {});
  const domains: AxesInput['domains'] = {};
  for (const name of ['y', 'z', 'height', 'size'] as const) {
    const d = data.channels[name];
    if (d) domains[name] = resolveDomain(layer.channels[name], d);
  }
  return { layer, data, table, domains, first, last, tStart: 0, dates: new DateLabels('Pacific/Auckland') };
}

describe('value labels', () => {
  it('sit above each bar, as written, skipping missing values', () => {
    const layer = bars((l) => (l.axes.values.enabled = true));
    const { texts, segments } = layoutAxes(input(layer));
    expect(segments).toEqual([]);
    expect(texts.map((t) => t.text)).toEqual(['16.2', '15.2', '14.0', '13.1', '12.5']);
    const first = texts[0]!;
    // Bar 0: x 100, top 140 + 16.2 / 20 * 500 = 545, plus the 8 px gap.
    expect(first.x).toBe(100);
    expect(first.y).toBeCloseTo(553, 3);
    expect(first.anchorY).toBe('bottom');
    // Row 4 (missing) is skipped: the last label is row 5's.
    expect(texts[4]!.x).toBe(100 + 5 * 60);
  });

  it('inside the top, the middle or at the base; with decimals, prefix and suffix', () => {
    const at = (place: InstancerLayer['axes']['values']['place']) =>
      layoutAxes(input(bars((l) => Object.assign(l.axes.values, { enabled: true, place, gap: 10 })))).texts[0]!;
    expect(at('inside-top').y).toBeCloseTo(545 - 10, 3);
    expect(at('inside-top').anchorY).toBe('top');
    expect(at('inside-middle').y).toBeCloseTo((140 + 545) / 2, 3);
    expect(at('base').y).toBeCloseTo(150, 3);
    const fmt = layoutAxes(input(bars((l) => Object.assign(l.axes.values, { enabled: true, decimals: 0, prefix: '~', suffix: '%' })))).texts;
    expect(fmt.map((t) => t.text)).toEqual(['~16%', '~15%', '~14%', '~13%', '~13%']);
  });

  it('centre on marks that are not bars, and follow the y channel', () => {
    const layer = bars((l) => {
      l.primitive = 'square';
      l.size = [20, 20, 20];
      l.channels.height.column = null;
      l.channels.y = { ...l.channels.y, column: 'Gender pay gap', domain: [0, 20], range: [0, 400] };
      l.axes.values.enabled = true;
    });
    const t = layoutAxes(input(layer)).texts[0]!;
    // Point at 140 + 16.2 / 20 * 400 = 464, half the square (10) above it, plus 8.
    expect(t.y).toBeCloseTo(482, 3);
  });

  it('a value column of its own (a category shows its text)', () => {
    const layer = bars((l) => Object.assign(l.axes.values, { enabled: true, column: 'Quarter' }));
    expect(layoutAxes(input(layer)).texts.map((t) => t.text)).toEqual(['Jun-98', 'Jun-99', 'Jun-00', 'Jun-01', 'Jun-03']);
  });

  it('only for the visible rows', () => {
    const layer = bars((l) => (l.axes.values.enabled = true));
    expect(layoutAxes(input(layer, 1, 2)).texts.map((t) => t.text)).toEqual(['15.2', '14.0']);
  });
});

describe('category axis', () => {
  it('a baseline under the visible marks and a label per row below it', () => {
    const layer = bars((l) => Object.assign(l.axes.x, { enabled: true, column: 'Quarter', gap: 10 }));
    const { segments, texts } = layoutAxes(input(layer));
    expect(segments).toHaveLength(1);
    // From half a bar (+4) before row 0 to half a bar after row 5.
    expect(segments[0]!.a).toEqual([100 - 24, 140, 0]);
    expect(segments[0]!.b).toEqual([100 + 300 + 24, 140, 0]);
    expect(texts.map((t) => t.text)).toEqual(['Jun-98', 'Jun-99', 'Jun-00', 'Jun-01', 'Jun-02', 'Jun-03']);
    expect([texts[0]!.x, texts[0]!.y, texts[0]!.anchorX, texts[0]!.anchorY]).toEqual([100, 130, 'center', 'top']);
  });

  it('every N rows, turned labels anchored at their end, a title, row numbers without a column', () => {
    const layer = bars((l) => Object.assign(l.axes.x, { enabled: true, column: null, every: 2, angle: 45, title: 'Quarter' }));
    const { texts } = layoutAxes(input(layer));
    expect(texts.slice(0, 3).map((t) => t.text)).toEqual(['1', '3', '5']);
    expect(texts[0]!.anchorX).toBe('right');
    expect(texts[0]!.rotation).toBeCloseTo(Math.PI / 4, 9);
    const title = texts.at(-1)!;
    expect(title.text).toBe('Quarter');
    expect(title.x).toBeCloseTo(250, 6);
    expect(title.y).toBeLessThan(130);
  });

  it('not for other arrangements', () => {
    const layer = bars((l) => {
      l.arrangement = 'radial';
      l.axes.x.enabled = true;
      l.axes.y.enabled = true;
    });
    expect(layoutAxes(input(layer))).toEqual({ segments: [], texts: [] });
  });
});

describe('value axis', () => {
  it('round ticks in the column units at the bars’ heights, left of the marks, with gridlines', () => {
    const layer = bars((l) => Object.assign(l.axes.y, { enabled: true, grid: true, suffix: '%', title: 'Gap' }));
    const { segments, texts } = layoutAxes(input(layer));
    const labels = texts.filter((t) => t.anchorX === 'right').map((t) => t.text);
    expect(labels).toEqual(['0%', '5%', '10%', '15%', '20%']);
    // The 10 tick: 140 + 10 / 20 * 500 = 390, left of the first bar (76) by 12 px, then the tick and gap.
    const ten = texts.find((t) => t.text === '10%')!;
    expect(ten.y).toBeCloseTo(390, 3);
    expect(ten.x).toBeCloseTo(76 - 12 - 8 - 6, 6);
    // Axis line + per tick: a tick mark and a gridline.
    expect(segments).toHaveLength(1 + 5 * 2);
    const grid = segments.filter((s) => s.opacity < 1);
    expect(grid).toHaveLength(5);
    expect(grid[0]!.b[0]).toBeCloseTo(424, 6); // to the far end of the baseline
    const title = texts.find((t) => t.text === 'Gap')!;
    expect(title.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(title.x).toBeLessThan(ten.x);
  });

  it('on the right, from an auto domain, nothing without a mapped value', () => {
    const auto = bars((l) => {
      l.channels.height.domain = null;
      Object.assign(l.axes.y, { enabled: true, side: 'right' });
    });
    const { texts } = layoutAxes(input(auto));
    expect(texts.every((t) => t.anchorX === 'left')).toBe(true);
    expect(texts[0]!.x).toBeGreaterThan(424);
    const none = bars((l) => {
      l.channels.height.column = null;
      l.axes.y.enabled = true;
    });
    expect(layoutAxes(input(none)).texts).toEqual([]);
  });
});

describe('during a reveal', () => {
  const chart = (span: 'visible' | 'full') =>
    bars((l) => {
      l.axes.span = span;
      Object.assign(l.axes.values, { enabled: true });
      Object.assign(l.axes.x, { enabled: true, column: 'Quarter', title: 'Quarter' });
      Object.assign(l.axes.y, { enabled: true, grid: true, title: 'Gap' });
    });

  it('keys every text, so a label keeps its identity as rows arrive', () => {
    const early = layoutAxes(input(chart('visible'), 0, 2)).texts;
    const later = layoutAxes(input(chart('visible'), 0, 4)).texts;
    const keys = later.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of early.filter((t) => !['xt', 'yt'].includes(t.key))) {
      expect(later.find((u) => u.key === t.key)?.text).toBe(t.text);
    }
    expect(keys).toContain('v:0');
    expect(keys).toContain('x:3');
    expect(keys).toContain('y:10');
  });

  it('full: lines, ticks, grid and titles span every row the animation reaches; labels only the visible rows', () => {
    const span = { first: 0, last: 5 };
    const growing = layoutAxes({ ...input(chart('full'), 0, 1), span });
    const whole = layoutAxes(input(chart('full')));
    expect(growing.segments).toEqual(whole.segments);
    const furniture = (texts: typeof whole.texts) => texts.filter((t) => t.key.startsWith('y:') || t.key === 'xt' || t.key === 'yt');
    expect(furniture(growing.texts)).toEqual(furniture(whole.texts));
    expect(growing.texts.filter((t) => t.key.startsWith('v:')).map((t) => t.key)).toEqual(['v:0', 'v:1']);
    expect(growing.texts.filter((t) => t.key.startsWith('x:')).map((t) => t.key)).toEqual(['x:0', 'x:1']);
  });

  it('visible (or no span given): everything grows with the rows', () => {
    const span = { first: 0, last: 5 };
    const visible = layoutAxes({ ...input(chart('visible'), 0, 1), span });
    expect(visible.segments).toEqual(layoutAxes(input(chart('full'), 0, 1)).segments);
    expect(visible.segments).not.toEqual(layoutAxes(input(chart('full'))).segments);
  });

  it('full with nothing visible yet still draws the axes', () => {
    const out = layoutAxes({ ...input(chart('full'), 0, -1), span: { first: 0, last: 5 } });
    expect(out.segments.length).toBeGreaterThan(0);
    expect(out.texts.some((t) => t.key.startsWith('v:') || t.key.startsWith('x:'))).toBe(false);
  });
});

describe('helpers', () => {
  it('mapValue is the shader maths', () => {
    expect(mapValue(5, { scale: 'linear', steps: 5, clamp: true, range: [0, 100] }, [0, 10])).toBe(50);
    expect(mapValue(25, { scale: 'sqrt', steps: 5, clamp: true, range: [0, 100] }, [0, 100])).toBeCloseTo(50, 9);
    expect(mapValue(50, { scale: 'linear', steps: 5, clamp: true, range: [0, 100] }, [0, 10])).toBe(100);
  });
  it('ticks stay in the domain; log ticks are thinned; decimals follow the step', () => {
    expect(axisTicks([7.3, 16.2], 'linear', 5)).toEqual([8, 10, 12, 14, 16]);
    expect(axisTicks([1, 10000], 'log', 5)).toEqual([1, 10, 100, 1000, 10000]);
    expect(axisTicks([3, 3], 'linear', 5)).toEqual([3]);
    expect(tickDecimals([0, 0.5, 1])).toBe(1);
    expect(tickDecimals([0, 0.25, 0.5])).toBe(2);
    expect(tickDecimals([0, 5, 10])).toBe(0);
  });
});
