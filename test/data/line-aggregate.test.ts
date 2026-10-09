import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { NumberColumn, TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import { buildLineData, monthOfDay, POINT_STRIDE, P_ROW, P_T, P_Y, segmentBroken } from '../../src/data/line-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankLineLayer, type LineLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const ZONE = 'Pacific/Auckland';
const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const rain = table.columns.find((c) => c.name === RAIN) as NumberColumn;
const cadences = { [TIME]: detectCadence(timeCol.values) };
const calendars = { [TIME]: calendarFields(timeCol.values, ZONE) };

function layer(aggregate: LineLayer['aggregate'], patch: Partial<LineLayer> = {}): LineLayer {
  const l = blankLineLayer('l1', 'L', 'ds');
  return { ...l, xMode: 'time', timeColumn: TIME, y: { ...l.y, column: RAIN }, aggregate, ...patch };
}

/** Month key of a row, worked out independently with Intl in the dataset timezone. */
const monthFormat = new Intl.DateTimeFormat('en-NZ', { timeZone: ZONE, year: 'numeric', month: '2-digit' });
const monthKey = (i: number) => monthFormat.format(timeCol.values[i]!);

describe('line aggregation', () => {
  it('monthOfDay handles leap years', () => {
    expect(monthOfDay(1900, 59)).toBe(2); // 1 Mar (1900 is not a leap year)
    expect(monthOfDay(2000, 59)).toBe(1); // 29 Feb
    expect(monthOfDay(1999, 364)).toBe(11);
  });

  it('monthly totals: one point per month, the sum of its readings, at the middle of the month', () => {
    const d = buildLineData(layer({ by: 'month', rows: 1, fn: 'sum' }), table, cadences, calendars);
    // Expected totals by month, independently.
    const totals = new Map<string, number>();
    for (let i = 0; i < table.rowCount; i++) {
      const v = rain.values[i]!;
      if (Number.isNaN(timeCol.values[i]!) || Number.isNaN(v)) continue;
      totals.set(monthKey(i), (totals.get(monthKey(i)) ?? 0) + v);
    }
    expect(d.count).toBe(totals.size);
    const first = [...totals.values()][0]!;
    expect(d.points[P_Y]).toBeCloseTo(first, 3);
    // Points are about a month apart (t is in days).
    const dt = d.points[POINT_STRIDE + P_T]! - d.points[P_T]!;
    expect(dt).toBeGreaterThan(25);
    expect(dt).toBeLessThan(35);
  });

  it('the gap rule counts in buckets: neighbouring months join, a missing stretch still breaks', () => {
    const d = buildLineData(layer({ by: 'month', rows: 1, fn: 'mean' }), table, cadences, calendars);
    let joined = 0;
    let broken = 0;
    for (let i = 0; i < d.count - 1; i++) {
      if (segmentBroken(d, i, true, 1.5)) broken++;
      else joined++;
    }
    expect(joined).toBeGreaterThan(d.count * 0.9);
    // The fixture has multi-month gaps in its record; those must not be bridged.
    const gaps = [];
    for (let i = 0; i < d.count - 1; i++) {
      const span = d.points[(i + 1) * POINT_STRIDE + P_T]! - d.points[i * POINT_STRIDE + P_T]!;
      if (span > 1.5 * (365.25 / 12)) gaps.push(i);
    }
    expect(broken).toBe(gaps.length);
  });

  it('every N rows: the mean of each run of N, as one point per run', () => {
    const d = buildLineData(layer({ by: 'rows', rows: 10, fn: 'mean' }, { xMode: 'index' }), table, cadences, calendars);
    expect(d.rowCount).toBe(Math.ceil(table.rowCount / 10));
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const v = rain.values[i]!;
      if (!Number.isNaN(v)) {
        sum += v;
        n++;
      }
    }
    expect(d.points[P_Y]).toBeCloseTo(sum / n, 4);
    expect(d.points[POINT_STRIDE + P_ROW]).toBe(1);
  });

  it('a bucket with no values is missing (never zero)', () => {
    const deficit = buildLineData(layer({ by: 'year', rows: 1, fn: 'sum' }, { y: { ...blankLineLayer('x', 'x', null).y, column: 'Deficit [mm]' } }), table, cadences, calendars);
    // Deficit is empty for its early years: those years get no point.
    const firstRow = deficit.points[P_ROW]!;
    expect(firstRow).toBeGreaterThan(0);
  });

  it('calendar buckets need a time column', () => {
    expect(() => buildLineData(layer({ by: 'month', rows: 1, fn: 'sum' }, { xMode: 'index', timeColumn: null }), table, cadences, calendars)).toThrow(LayerDataError);
  });
});
