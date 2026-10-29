import { describe, expect, it } from 'vitest';
import { layoutAxes, mapValue, type AxesInput } from '../../src/data/instance-axes.ts';
import { buildInstanceData, MISSING, resolveDomain } from '../../src/data/instance-data.ts';
import { DateLabels } from '../../src/data/instance-labels.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankInstancerLayer, defaultAxes, LayerSchema, type InstancerLayer } from '../../src/shared/layer-schema.ts';

// A scatter plot: x from one column, y from another, no step along the rows.
const table = parseCsv(['a,b', '1,10', '3,30', ',20', '5,50'].join('\n')).table;

function scatter(edit: (l: InstancerLayer) => void = () => {}): InstancerLayer {
  const l = blankInstancerLayer('ly', 'scatter', 'ds');
  l.primitive = 'point';
  l.origin = [200, 100, 0];
  l.step = [0, 0, 0];
  l.channels.x = { ...l.channels.x, column: 'a', domain: [0, 10], range: [0, 1000] };
  l.channels.y = { ...l.channels.y, column: 'b', domain: [0, 100], range: [0, 500] };
  l.axes = defaultAxes();
  edit(l);
  return l;
}

function input(layer: InstancerLayer): AxesInput {
  const data = buildInstanceData(layer, table, {}, {});
  const domains: AxesInput['domains'] = {};
  for (const name of ['x', 'y', 'z', 'height', 'size'] as const) {
    const d = data.channels[name];
    if (d) domains[name] = resolveDomain(layer.channels[name], d);
  }
  return { layer, data, table, domains, first: 0, last: table.rowCount - 1, tStart: 0, dates: new DateLabels('UTC') };
}

describe('instancer x channel (scatter)', () => {
  it('blank instancers have an unmapped x channel; the schema accepts a mapped one', () => {
    const l = blankInstancerLayer('ly', 'L', null);
    expect(l.channels.x.column).toBeNull();
    expect(LayerSchema.safeParse(scatter()).success).toBe(true);
  });

  it('x values are uploaded with MISSING where missing', () => {
    const d = buildInstanceData(scatter(), table, {}, {});
    expect([...d.channels.x!.values]).toEqual([1, 3, MISSING, 5]);
  });

  it('value labels sit at the x offset; missing x hides the mark', () => {
    const { texts } = layoutAxes(input(scatter((l) => Object.assign(l.axes.values, { enabled: true, gap: 0 }))));
    expect(texts.map((t) => [t.text, t.x])).toEqual([
      ['10', 300],
      ['30', 500],
      ['50', 700],
    ]);
  });

  it('the x axis is a value axis: ticks in the x column’s units along the line', () => {
    const layer = scatter((l) => Object.assign(l.axes.x, { enabled: true, gap: 4, title: 'a' }));
    const { texts, segments } = layoutAxes(input(layer));
    const ticks = texts.filter((t) => t.key.startsWith('xv:'));
    expect(ticks.map((t) => t.text)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    for (const t of ticks) expect(t.x).toBeCloseTo(200 + mapValue(Number(t.text), layer.channels.x, [0, 10]), 6);
    expect(texts.some((t) => t.key.startsWith('x:'))).toBe(false);
    expect(texts.find((t) => t.key === 'xt')?.text).toBe('a');
    // The axis line spans the mapped x range (plus half a mark either side).
    const axis = segments[0]!;
    expect(axis.a[0]).toBeLessThanOrEqual(200);
    expect(axis.b[0]).toBeGreaterThanOrEqual(1200);
  });
});
