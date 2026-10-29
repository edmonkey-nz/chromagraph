import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { mapValue } from '../../src/data/instance-axes.ts';
import { DateLabels } from '../../src/data/instance-labels.ts';
import { layoutLineAxes } from '../../src/data/line-axes.ts';
import { buildLineData, linePositions } from '../../src/data/line-data.ts';
import { splitSeries } from '../../src/data/line-split.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { lineChartPreset } from '../../src/shared/chart-presets.ts';
import { CHART_BASE, CHART_LEFT, summarise } from '../../src/shared/layer-defaults.ts';
import { blankLineLayer, defaultAxes, LayerSchema, type LineLayer } from '../../src/shared/layer-schema.ts';

// Daily values over Jan–Mar 2000, two series (A and B).
const rows: string[] = ['when,v,s'];
for (let d = 0; d < 91; d++) {
  const ms = Date.UTC(2000, 0, 1) + d * 86_400_000;
  rows.push(`${new Date(ms).toISOString()},${(d % 10) + 1},A`, `${new Date(ms).toISOString()},${(d % 7) + 20},B`);
}
const { table } = parseCsv(rows.join('\n'));
const when = table.columns.find((c) => c.name === 'when') as TimeColumn;
const cadences = { when: detectCadence(when.values) };
const calendars = { when: calendarFields(when.values, 'UTC') };
const dates = new DateLabels('UTC');

function line(patch: Partial<LineLayer> = {}): LineLayer {
  const l = blankLineLayer('l', 'L', 'ds');
  return { ...l, xMode: 'index', origin: [100, 200, 0], step: [5, 0, 0], y: { ...l.y, column: 'v', domain: [0, 30], range: [0, 600] }, axes: defaultAxes(), ...patch };
}
const layout = (l: LineLayer, t = table) => {
  const data = buildLineData(l, t, cadences, calendars);
  return { data, out: layoutLineAxes({ layer: l, series: [{ data, table: t }], dates, timeZone: 'UTC' }) };
};

describe('line axes', () => {
  it('nothing on: nothing drawn', () => {
    const { out } = layout(line());
    expect(out).toEqual({ segments: [], texts: [] });
  });

  it('value labels sit on the drawn points', () => {
    const l = line();
    l.axes.values = { ...l.axes.values, enabled: true, gap: 0 };
    const { data, out } = layout(l);
    const pos = linePositions(data, l);
    expect(out.texts).toHaveLength(data.count);
    expect(out.texts[3]!.x).toBeCloseTo(pos[9]!, 4);
    expect(out.texts[3]!.y).toBeCloseTo(pos[10]!, 4);
    expect(out.texts[3]!.text).toBe('21'); // row 3 is series B on day 1
  });

  it('aggregated by month: one label per month, named by the period, at the bucket’s point', () => {
    const l = line({ xMode: 'time', timeColumn: 'when', aggregate: { by: 'month', rows: 30, fn: 'mean' } });
    l.axes.x = { ...l.axes.x, enabled: true };
    const { data, out } = layout(l);
    const xs = out.texts.filter((t) => t.key.startsWith('x:'));
    expect(xs.map((t) => t.text)).toEqual(['Jan 2000', 'Feb 2000', 'Mar 2000']);
    const pos = linePositions(data, l);
    expect(xs[1]!.x).toBeCloseTo(pos[3]!, 4);
    // The baseline is at the bottom of the y range.
    expect(out.segments[0]!.a[1]).toBeCloseTo(200 + mapValue(0, l.y, [0, 30]), 6);
  });

  it('every-N-rows buckets are named by their rows', () => {
    const l = line({ aggregate: { by: 'rows', rows: 60, fn: 'mean' } });
    l.axes.x = { ...l.axes.x, enabled: true };
    const xs = layout(l).out.texts.filter((t) => t.key.startsWith('x:'));
    expect(xs[0]!.text).toBe('1–60');
  });

  it('labels thin themselves so they never overlap', () => {
    const l = line({ step: [2, 0, 0] });
    l.axes.x = { ...l.axes.x, enabled: true, size: 24 };
    const xs = layout(l).out.texts.filter((t) => t.key.startsWith('x:'));
    expect(xs.length).toBeLessThan(182);
    for (let i = 1; i < xs.length; i++) {
      const width = Math.max(xs[i]!.text.length, xs[i - 1]!.text.length) * 0.55 * 24;
      expect(xs[i]!.x - xs[i - 1]!.x).toBeGreaterThanOrEqual(width);
    }
  });

  it('the y axis ticks in the y column’s units at the mapped heights, with gridlines', () => {
    const l = line();
    l.axes.y = { ...l.axes.y, enabled: true, grid: true, ticks: 3 };
    const { out } = layout(l);
    const ys = out.texts.filter((t) => t.key.startsWith('y:'));
    expect(ys.map((t) => t.text)).toEqual(['0', '10', '20', '30']);
    expect(ys[2]!.y).toBeCloseTo(200 + mapValue(20, l.y, [0, 30]), 6);
    expect(ys[0]!.x).toBeLessThan(100);
    expect(out.segments.some((s) => s.opacity < 1)).toBe(true);
  });

  it('split lines share one set of axes; value labels for every series', () => {
    const l = line({ split: { ...blankLineLayer('x', 'x', null).split, column: 's' } });
    l.axes.values = { ...l.axes.values, enabled: true };
    l.axes.x = { ...l.axes.x, enabled: true };
    const series = splitSeries({ table, cadences, calendars }, 's').map((s) => ({ data: buildLineData(l, s.data.table, s.data.cadences, s.data.calendars), table: s.data.table }));
    const out = layoutLineAxes({ layer: l, series, dates, timeZone: 'UTC' });
    expect(out.texts.filter((t) => t.key.startsWith('v:0:')).length).toBe(91);
    expect(out.texts.filter((t) => t.key.startsWith('v:1:')).length).toBe(91);
    expect(out.segments.length).toBe(1);
  });

  it('the line chart preset aggregates, turns both axes on and fits with room for them', () => {
    const summary = summarise(table, cadences);
    const l = lineChartPreset({ ...line(), xMode: 'time', timeColumn: 'when', y: { ...line().y, domain: [0, 30] } }, summary);
    expect(l.aggregate.by).toBe('month');
    expect(l.axes.x.enabled && l.axes.y.enabled && l.axes.y.grid).toBe(true);
    expect(l.y.domain).toBeNull();
    expect(l.origin[1]).toBe(CHART_BASE);
    expect(l.origin[0]).toBeCloseTo(CHART_LEFT, 6);
    expect(LayerSchema.safeParse(l).success).toBe(true);
  });
});
