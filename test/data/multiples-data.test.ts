import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import { rowRange } from '../../src/data/line-data.ts';
import {
  monthDay,
  multiplesDomain,
  multiplesStructureKey,
  panelDomain,
  panelLabel,
  panelTopLeft,
  splitRows,
  visibleEntries,
  visiblePanels,
  type MultiplesData,
} from '../../src/data/multiples-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankMultiplesLayer, type SmallMultiplesLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const SOURCE = 'Data Source (rainfall)';
const DEFICIT = 'Deficit [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const calendars = { [TIME]: calendarFields(timeCol.values, 'Pacific/Auckland') };
const rainNulls = table.columns.find((c) => c.name === RAIN)!.nullCount;

function layer(patch: Partial<SmallMultiplesLayer> = {}): SmallMultiplesLayer {
  return { ...blankMultiplesLayer('m1', 'M', 'ds'), splitColumn: TIME, valueColumn: RAIN, ...patch };
}

function split(patch: Partial<SmallMultiplesLayer> = {}): MultiplesData {
  return splitRows(layer(patch), table, calendars)!;
}

const rowOf = (iso: string) => timeCol.values.indexOf(Date.parse(iso));
const entryOfRow = (d: MultiplesData, row: number) => d.row.indexOf(row);

describe('splitRows: year', () => {
  const d = split();

  it('makes one panel per year, 1879 to 1997', () => {
    expect(d.panelCount).toBe(119);
    expect(d.firstKey).toBe(1879);
    expect(panelLabel(d, 0)).toBe('1879');
    expect(panelLabel(d, 118)).toBe('1997');
    expect(d.slots).toBe(366);
  });

  it('skips rows with a missing value (never drawn as zero)', () => {
    expect(rainNulls).toBe(0);
    expect(d.count).toBe(table.rowCount);
    const deficit = table.columns.find((c) => c.name === DEFICIT)!;
    if (deficit.type !== 'number') throw new Error('expected numbers');
    const sparse = split({ valueColumn: DEFICIT });
    expect(sparse.count).toBe(table.rowCount - deficit.nullCount);
    for (let e = 0; e < sparse.count; e++) expect(Number.isNaN(deficit.values[sparse.row[e]!]!)).toBe(false);
  });

  it('places a row at day of year / 366 in its local year', () => {
    // 1923-03-01 09:00 NZST is 1923-02-28T21:30Z (NZ Mean Time, +11:30): day 59 of 1923.
    const row = rowOf('1923-02-28T21:00:00Z');
    expect(row).toBeGreaterThan(0);
    const e = entryOfRow(d, row);
    expect(d.panel[e]).toBe(1923 - 1879);
    expect(d.x[e]).toBeCloseTo(59 / 366, 6);
  });

  it('keeps x in 0..1 and entries in row order', () => {
    for (let e = 0; e < d.count; e++) {
      expect(d.x[e]!).toBeGreaterThanOrEqual(0);
      expect(d.x[e]!).toBeLessThan(1);
      if (e > 0) expect(d.row[e]!).toBeGreaterThan(d.row[e - 1]!);
    }
    expect(d.monotone).toBe(true);
  });

  it('computes per-panel and shared domains', () => {
    const rain = table.columns.find((c) => c.name === RAIN)!;
    expect(multiplesDomain('linear', null, d)).toEqual([Math.fround(rain.min), Math.fround(rain.max)]);
    expect(multiplesDomain('linear', [0, 50], d)).toEqual([0, 50]);
    // Rain has zeros, so an auto log domain starts at the smallest positive value.
    expect(multiplesDomain('log', null, d)[0]).toBeGreaterThan(0);
    let max = -Infinity;
    for (let e = 0; e < d.count; e++) if (d.panel[e] === 44) max = Math.max(max, d.value[e]!);
    expect(panelDomain('linear', d, 44)[1]).toBe(max);
  });
});

describe('splitRows: month, decade, rows, category', () => {
  it('month: key year * 12 + month, x from the day of month', () => {
    const d = split({ splitBy: 'month' });
    expect(d.slots).toBe(31);
    const row = rowOf('1923-02-28T21:00:00Z'); // 1 March 1923 local
    const e = entryOfRow(d, row);
    expect(panelLabel(d, d.panel[e]!)).toBe('Mar 1923');
    expect(d.x[e]).toBe(0);
    expect(d.firstKey).toBe(1879 * 12);
    expect(panelLabel(d, 0)).toBe('Jan 1879');
  });

  it('decade: x is the year within the decade with its day fraction', () => {
    const d = split({ splitBy: 'decade' });
    expect(panelLabel(d, 0)).toBe('1870s');
    expect(panelLabel(d, d.panelCount - 1)).toBe('1990s');
    expect(d.panelCount).toBe(13);
    const e = entryOfRow(d, rowOf('1923-02-28T21:00:00Z'));
    expect(panelLabel(d, d.panel[e]!)).toBe('1920s');
    expect(d.x[e]).toBeCloseTo((3 + 59 / 366) / 10, 6);
  });

  it('rows: fixed chunks with x the index within the chunk', () => {
    const d = split({ splitBy: 'rows', splitColumn: null, chunkRows: 365 });
    expect(d.panelCount).toBe(Math.ceil(table.rowCount / 365));
    expect(panelLabel(d, 0)).toBe('rows 0–364');
    expect(panelLabel(d, d.panelCount - 1)).toBe(`rows ${(d.panelCount - 1) * 365}–${table.rowCount - 1}`);
    const e = d.count - 1;
    expect(d.panel[e]).toBe(Math.floor(d.row[e]! / 365));
    expect(d.x[e]).toBeCloseTo((d.row[e]! % 365) / 365, 6);
  });

  it('category: panels in dictionary order, x the index within the category', () => {
    const csv = ['kind,v', 'b,1', 'a,2', 'b,', 'b,4', ',5', 'a,6'].join('\n');
    const t = parseCsv(csv).table;
    const kind = t.columns.find((c) => c.name === 'kind')!;
    expect(kind.type).toBe('category');
    const d = splitRows(layer({ splitBy: 'category', splitColumn: 'kind', valueColumn: 'v' }), t, {})!;
    expect(d.panelCount).toBe(2);
    expect(panelLabel(d, 0)).toBe('b');
    expect(panelLabel(d, 1)).toBe('a');
    // Three rows of "b" (one with a missing value, which keeps its slot), two of "a".
    expect(d.slots).toBe(3);
    expect(Array.from(d.row)).toEqual([0, 1, 3, 5]);
    expect(Array.from(d.panel)).toEqual([0, 1, 0, 1]);
    expect(Array.from(d.x)).toEqual([0, 0, 2 / 3, 1 / 3].map(Math.fround));
    expect(d.monotone).toBe(false);
    expect(visiblePanels(d, 1, 2)).toEqual([0, 2]);
  });
});

describe('splitRows: configuration', () => {
  it('waits for a value or split column', () => {
    expect(splitRows(layer({ valueColumn: null }), table, calendars)).toBeNull();
    expect(splitRows(layer({ splitColumn: null }), table, calendars)).toBeNull();
    expect(splitRows(layer({ splitBy: 'rows', splitColumn: null }), table, calendars)).not.toBeNull();
  });

  it('rejects missing and wrongly typed columns', () => {
    expect(() => splitRows(layer({ valueColumn: 'nope' }), table, calendars)).toThrow(LayerDataError);
    expect(() => splitRows(layer({ valueColumn: TIME }), table, calendars)).toThrow(/need numbers/);
    expect(() => splitRows(layer({ splitColumn: RAIN }), table, calendars)).toThrow(/needs a time column/);
    expect(() => splitRows(layer({ splitBy: 'category', splitColumn: TIME }), table, calendars)).toThrow(/category column/);
    expect(() => splitRows(layer({ splitColumn: SOURCE }), table, calendars)).toThrow(LayerDataError);
  });

  it('structure key ignores layout, style and rows', () => {
    const a = multiplesStructureKey(layer(), 'Pacific/Auckland');
    expect(multiplesStructureKey(layer({ columns: 3, origin: [0, 0, 0], panelSize: [1, 1], rows: [0.2, 0.4], chart: 'dots', scale: 'log' }), 'Pacific/Auckland')).toBe(a);
    expect(multiplesStructureKey(layer({ splitBy: 'month' }), 'Pacific/Auckland')).not.toBe(a);
    expect(multiplesStructureKey(layer(), 'UTC')).not.toBe(a);
    expect(multiplesStructureKey(layer({ chunkRows: 10 }), 'Pacific/Auckland')).toBe(a);
    expect(multiplesStructureKey(layer({ splitBy: 'rows', chunkRows: 10 }), 'UTC')).not.toBe(
      multiplesStructureKey(layer({ splitBy: 'rows', chunkRows: 20 }), 'UTC'),
    );
  });
});

describe('rows range and layout', () => {
  const d = split();

  it('skips rows outside `rows` as an entry range', () => {
    const [first, last] = rowRange([0, 365 / table.rowCount], table.rowCount);
    const [start, count] = visibleEntries(d, first, last);
    expect(start).toBe(0);
    for (let e = start; e < start + count; e++) expect(d.row[e]!).toBeLessThanOrEqual(last);
    expect(d.row[start + count] ?? Infinity).toBeGreaterThan(last);
    expect(visiblePanels(d, start, count)[0]).toBe(0);
    const [s2, c2] = visibleEntries(d, ...rowRange([0.5, 1], table.rowCount));
    const [p0, pn] = visiblePanels(d, s2, c2);
    expect(p0).toBeGreaterThan(50);
    expect(p0 + pn).toBe(119);
    expect(visibleEntries(d, 10, 5)).toEqual([0, 0]);
  });

  it('places panel slots on the grid, filling downward', () => {
    expect(panelTopLeft(0, 12, [60, 1020, 0], [140, 70], [10, 10])).toEqual([60, 1020]);
    expect(panelTopLeft(13, 12, [60, 1020, 0], [140, 70], [10, 10])).toEqual([60 + 150, 1020 - 80]);
  });

  it('monthDay handles leap years', () => {
    expect(monthDay(1923, 59)).toEqual([2, 1]);
    expect(monthDay(1924, 59)).toEqual([1, 29]);
    expect(monthDay(1924, 365)).toEqual([11, 31]);
    expect(monthDay(1923, 0)).toEqual([0, 1]);
  });
});
