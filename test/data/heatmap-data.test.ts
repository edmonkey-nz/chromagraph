import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields, type CalendarFields } from '../../src/data/calendar.ts';
import type { Table, TimeColumn } from '../../src/data/columns.ts';
import {
  CALENDAR_DAYS,
  cellScratch,
  EMPTY_CELL,
  fillCells,
  heatmapDomain,
  heatmapGrid,
  heatmapStructureKey,
  prepareHeatmap,
  textureShape,
  VOID_CELL,
  type Aggregate,
} from '../../src/data/heatmap-data.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankHeatmapLayer, type HeatmapLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const DEFICIT = 'Deficit [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const calendars = { [TIME]: calendarFields(timeCol.values, 'Pacific/Auckland') };

function layer(patch: Partial<HeatmapLayer> = {}): HeatmapLayer {
  return { ...blankHeatmapLayer('h1', 'H', 'ds'), valueColumn: RAIN, ...patch };
}

function cells(l: HeatmapLayer, t: Table = table, cal: Record<string, CalendarFields> = calendars, first = 0, last = Infinity) {
  const src = prepareHeatmap(l, t, cal)!;
  const out = new Float32Array(src.cellCount);
  const stats = fillCells(src, l.aggregate, first, last, out, cellScratch(src));
  return { src, out, stats };
}

/** A small hand-made table: several readings on the same local days. */
function tinyTable(): { table: Table; calendars: Record<string, ReturnType<typeof calendarFields>> } {
  const times = new Float64Array([
    Date.parse('2000-01-01T00:00:00Z'),
    Date.parse('2000-01-01T06:00:00Z'),
    Date.parse('2000-01-01T12:00:00Z'),
    Date.parse('2000-01-03T00:00:00Z'),
    Date.parse('2001-01-01T00:00:00Z'),
    NaN,
  ]);
  const values = new Float32Array([1, 5, 3, NaN, 7, 9]);
  const t: Table = {
    rowCount: 6,
    columns: [
      { name: 'when', index: 0, length: 6, nullCount: 1, empty: false, min: times[0]!, max: times[4]!, type: 'time', values: times, assumedUtc: false },
      { name: 'v', index: 1, length: 6, nullCount: 1, empty: false, min: 1, max: 9, type: 'number', values },
    ],
  };
  return { table: t, calendars: { when: calendarFields(times, 'UTC') } };
}

describe('calendar layout', () => {
  it('is years x 366 for the rainfall record', () => {
    const { src, out, stats } = cells(layer({ layout: 'calendar', timeColumn: TIME }));
    expect(src.years).toBe(1997 - 1879 + 1);
    expect(src.years).toBe(119);
    expect(src.cellCount).toBe(119 * 366);
    expect(heatmapGrid(src, 100)).toEqual([366, 119]);
    // 1879-01-02 (local) is day 1 of the first year; 1 Jan 1879 has no reading.
    expect(out[0]).toBe(EMPTY_CELL);
    expect(out[1]).toBe(0);
    // 1879 is a common year, so its day 366 is not a date at all.
    expect(out[CALENDAR_DAYS - 1]).toBe(VOID_CELL);
    // 1880 is a leap year: 31 Dec is a real (here filled) day.
    expect(out[2 * CALENDAR_DAYS - 1]).not.toBe(VOID_CELL);
    expect(stats.filled).toBe(42_748);
    expect(stats.min).toBe(0);
  });

  it('keeps gap days empty (never filled in)', () => {
    const { src, out } = cells(layer({ layout: 'calendar', timeColumn: TIME }));
    // 1996-05-15 (local) falls in the gap between 30 April and 2 June 1996.
    const year = 1996 - src.firstYear;
    const day = 31 + 29 + 31 + 30 + 14; // 15 May, leap year, 0-based
    expect(out[year * CALENDAR_DAYS + day]).toBe(EMPTY_CELL);
  });

  it('combines rows on the same day per aggregate', () => {
    const tiny = tinyTable();
    const expected: Record<Aggregate, number> = { mean: 3, sum: 9, min: 1, max: 5, last: 3 };
    for (const aggregate of Object.keys(expected) as Aggregate[]) {
      const { out } = cells(layer({ layout: 'calendar', timeColumn: 'when', valueColumn: 'v', aggregate }), tiny.table, tiny.calendars);
      expect(out[0], aggregate).toBe(expected[aggregate]);
      // The only reading on 3 Jan is missing: the cell stays empty for every aggregate.
      expect(out[2], aggregate).toBe(EMPTY_CELL);
      expect(out[1], aggregate).toBe(EMPTY_CELL);
      expect(out[CALENDAR_DAYS], aggregate).toBe(7);
    }
  });

  it('restricts to the rows range without changing the shape', () => {
    const tiny = tinyTable();
    const { src, out } = cells(layer({ layout: 'calendar', timeColumn: 'when', valueColumn: 'v', aggregate: 'sum' }), tiny.table, tiny.calendars, 1, 1);
    expect(src.cellCount).toBe(2 * CALENDAR_DAYS);
    expect(out[0]).toBe(5);
    expect(out[CALENDAR_DAYS]).toBe(EMPTY_CELL);
  });
});

describe('grid layout', () => {
  it('has one cell per row and keeps missing values empty', () => {
    const { src, out, stats } = cells(layer({ valueColumn: DEFICIT }));
    expect(src.cellCount).toBe(42_748);
    expect(heatmapGrid(src, 100)).toEqual([100, 428]);
    expect(out[0]).toBe(EMPTY_CELL);
    const deficit = table.columns.find((c) => c.name === DEFICIT)!;
    expect(stats.filled).toBe(42_748 - deficit.nullCount);
    expect(textureShape(src.cellCount)).toEqual([2048, 21]);
  });
});

describe('configuration', () => {
  it('is not built until configured', () => {
    expect(prepareHeatmap(layer({ valueColumn: null }), table, calendars)).toBeNull();
    expect(prepareHeatmap(layer({ layout: 'calendar', timeColumn: null }), table, calendars)).toBeNull();
  });

  it('reports bad columns as LayerDataError', () => {
    expect(() => prepareHeatmap(layer({ valueColumn: 'Nope' }), table, calendars)).toThrow(LayerDataError);
    expect(() => prepareHeatmap(layer({ valueColumn: 'Data Source (rainfall)' }), table, calendars)).toThrow(/needs numbers/);
    expect(() => prepareHeatmap(layer({ layout: 'calendar', timeColumn: RAIN }), table, calendars)).toThrow(/not a time column/);
    expect(() => prepareHeatmap(layer({ layout: 'calendar', timeColumn: TIME }), table, {})).toThrow(/not available/);
  });

  it('structure key ignores rows, aggregate, domain and colours', () => {
    const a = layer({ layout: 'calendar', timeColumn: TIME });
    const key = heatmapStructureKey(a, 'Pacific/Auckland');
    expect(heatmapStructureKey({ ...a, rows: [0, 0.5], aggregate: 'max', domain: [0, 5], ramp: 'magma', gridColumns: 7 }, 'Pacific/Auckland')).toBe(key);
    expect(heatmapStructureKey(a, 'UTC')).not.toBe(key);
    expect(heatmapStructureKey({ ...a, valueColumn: DEFICIT }, 'Pacific/Auckland')).not.toBe(key);
  });
});

describe('heatmapDomain', () => {
  const stats = { min: 0, max: 200, minPositive: 0.2, filled: 10 };
  it('is auto from the cells, explicit when set', () => {
    expect(heatmapDomain('linear', null, stats)).toEqual([0, 200]);
    expect(heatmapDomain('log', null, stats)).toEqual([0.2, 200]);
    expect(heatmapDomain('linear', [1, 2], stats)).toEqual([1, 2]);
    expect(heatmapDomain('linear', null, { min: NaN, max: NaN, minPositive: NaN, filled: 0 })).toEqual([0, 1]);
  });
});
