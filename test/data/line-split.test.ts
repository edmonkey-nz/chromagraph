import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { NumberColumn, TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { buildLineData, lastVisiblePoint, linePositions, P_Y, POINT_STRIDE, wantsBand } from '../../src/data/line-data.ts';
import { splitSeries } from '../../src/data/line-split.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { RowFilterError } from '../../src/data/row-filter.ts';
import { blankLineLayer, LayerSchema, MAX_SPLIT, seriesColour, SERIES_COLOURS, type LineLayer } from '../../src/shared/layer-schema.ts';

// Long format: Female starts a year later than Male, so a shared time origin matters.
const CSV = [
  'when,Sex,number',
  '2009-01-01T00:00:00Z,Male,396',
  '2010-01-01T00:00:00Z,Female,147',
  '2010-01-01T00:00:00Z,Male,388',
  '2011-01-01T00:00:00Z,Female,150',
  '2011-01-01T00:00:00Z,Male,401',
  '2012-01-01T00:00:00Z,Female,',
  '2012-01-01T00:00:00Z,Male,420',
].join('\n');
const { table } = parseCsv(CSV);
const when = table.columns.find((c) => c.name === 'when') as TimeColumn;
const data = { table, cadences: { when: detectCadence(when.values) }, calendars: { when: calendarFields(when.values, 'UTC') } };

function line(patch: Partial<LineLayer> = {}): LineLayer {
  const l = blankLineLayer('l', 'L', 'ds');
  return { ...l, xMode: 'time', timeColumn: 'when', origin: [100, 100, 0], step: [10, 0, 0], y: { ...l.y, column: 'number', range: [0, 100] }, ...patch };
}

describe('line split', () => {
  it('one series per value, in first-seen order, with dictionary indices', () => {
    const s = splitSeries(data, 'Sex');
    expect(s.map((x) => [x.value, x.index, x.data.table.rowCount])).toEqual([
      ['Male', 0, 4],
      ['Female', 1, 3],
    ]);
  });

  it('series share the time origin, cadence step and value range of the whole table', () => {
    const [male, female] = splitSeries(data, 'Sex');
    const mt = male!.data.table.columns.find((c) => c.name === 'when') as TimeColumn;
    const ft = female!.data.table.columns.find((c) => c.name === 'when') as TimeColumn;
    expect(ft.min).toBe(mt.min);
    expect(ft.min).toBe(when.min);
    expect(female!.data.cadences.when!.step).toBe(male!.data.cadences.when!.step);
    const fn = female!.data.table.columns.find((c) => c.name === 'number') as NumberColumn;
    expect([fn.min, fn.max]).toEqual([147, 420]);
    // So Female's 2010 point sits one year along, where Male's 2010 point is.
    const layer = line();
    const mPos = linePositions(buildLineData(layer, male!.data.table, male!.data.cadences), layer);
    const fPos = linePositions(buildLineData(layer, female!.data.table, female!.data.cadences), layer);
    expect(fPos[0]).toBeCloseTo(mPos[3]!, 3);
  });

  it('missing values stay missing within a series', () => {
    const female = splitSeries(data, 'Sex')[1]!;
    const d = buildLineData(line(), female.data.table, female.data.cadences);
    expect(d.count).toBe(2); // 2012 has no number
  });

  it('refuses non-category columns, missing columns and too many values', () => {
    expect(() => splitSeries(data, 'number')).toThrow(/category or text/);
    expect(() => splitSeries(data, 'Nope')).toThrow(RowFilterError);
    const many = parseCsv(['k,v', ...Array.from({ length: (MAX_SPLIT + 1) * 3 }, (_, i) => `k${i % (MAX_SPLIT + 1)},${i}`)].join('\n')).table;
    expect(() => splitSeries({ table: many, cadences: {}, calendars: {} }, 'k')).toThrow(/at most 24/);
  });

  it('series colours: chosen per value, else the palette by index', () => {
    expect(seriesColour({ colours: {} }, 'Male', 0)).toBe(SERIES_COLOURS[0]);
    expect(seriesColour({ colours: { Male: '#ff0000' } }, 'Male', 0)).toBe('#ff0000');
    expect(seriesColour({ colours: {} }, 'x', SERIES_COLOURS.length + 1)).toBe(SERIES_COLOURS[1]);
  });

  it('lastVisiblePoint is the CPU placement of the last point in the visible rows', () => {
    const male = splitSeries(data, 'Sex')[0]!;
    const layer = line();
    const d = buildLineData(layer, male.data.table, male.data.cadences);
    const all = linePositions(d, layer);
    const out = [0, 0, 0];
    expect(lastVisiblePoint(d, layer, out)).toBe(true);
    expect(out).toEqual([all[9], all[10], all[11]]);
    expect(lastVisiblePoint(d, { ...layer, rows: [0, 0.5] }, out)).toBe(true);
    expect(out[0]).toBeCloseTo(all[3]!, 5);
    expect(lastVisiblePoint(d, { ...layer, rows: [0, 0] }, out)).toBe(false);
  });

  it('schema: lines take a split; a blank line has none', () => {
    const l = line();
    expect(l.split.column).toBeNull();
    expect(LayerSchema.safeParse({ ...l, split: { ...l.split, column: 'Sex', colours: { Male: '#123456' } } }).success).toBe(true);
    expect(LayerSchema.safeParse({ ...l, split: { ...l.split, colours: { Male: 'red' } } }).success).toBe(false);
  });
});

describe('line band', () => {
  // Two rows per bucket of 2 rows: (1, 5), (2, 8), (3, -) .
  const t = parseCsv(['v', '1', '5', '2', '8', '3', ''].join('\n')).table;
  const band = (patch: Partial<LineLayer>) => {
    const l = blankLineLayer('l', 'L', 'ds');
    return { ...l, y: { ...l.y, column: 'v' }, aggregate: { by: 'rows' as const, rows: 2, fn: 'mean' as const }, fill: { ...l.fill, mode: 'band' as const }, ...patch };
  };

  it('needs aggregation and a y column', () => {
    expect(wantsBand(band({}))).toBe(true);
    const l = band({});
    expect(wantsBand({ ...l, aggregate: { ...l.aggregate, by: 'none' } })).toBe(false);
    expect(wantsBand({ ...l, y: { ...l.y, column: null } })).toBe(false);
    expect(wantsBand({ ...l, fill: { ...l.fill, mode: 'below' } })).toBe(false);
    expect(buildLineData({ ...l, aggregate: { ...l.aggregate, by: 'none' } }, t, {}).band).toBeNull();
  });

  it('keeps each bucket’s min and max, and the y domain covers them', () => {
    const d = buildLineData(band({}), t, {});
    expect(d.band).not.toBeNull();
    expect([...d.band!.lo]).toEqual([1, 2, 3]);
    expect([...d.band!.hi]).toEqual([5, 8, 3]);
    expect([0, 1, 2].map((p) => d.points[p * POINT_STRIDE + P_Y])).toEqual([3, 5, 3]);
    expect(d.y!.autoDomain).toEqual([1, 8]);
    // Without the band, the domain is the means'.
    const plain = buildLineData(band({ fill: { mode: 'none', colour: '#000000', opacity: 1 } }), t, {});
    expect(plain.y!.autoDomain).toEqual([3, 5]);
  });
});
