import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { parseCsv } from '../../src/data/parse.ts';

const ms = (iso: string) => Date.parse(iso);

describe('calendarFields', () => {
  it('uses the local date in the given zone', () => {
    const { year, dayOfYear } = calendarFields(
      new Float64Array([ms('1879-01-01T21:00:00Z'), ms('2020-12-31T12:00:00Z'), ms('2021-06-30T20:00:00Z')]),
      'Pacific/Auckland',
    );
    // 21:00Z on 1 Jan 1879 is 08:30 on 2 Jan in NZ Mean Time (+11:30).
    expect([year[0], dayOfYear[0]]).toEqual([1879, 1]);
    // 12:00Z 31 Dec 2020 is 01:00 on 1 Jan 2021 in NZDT (+13).
    expect([year[1], dayOfYear[1]]).toEqual([2021, 0]);
    // 20:00Z 30 Jun 2021 is 08:00 on 1 Jul (NZST +12); 2021 is not a leap year.
    expect([year[2], dayOfYear[2]]).toEqual([2021, 181]);
  });

  it('counts leap days and keeps missing values missing', () => {
    const { year, dayOfYear } = calendarFields(new Float64Array([ms('2020-12-31T00:00:00Z'), NaN]), 'UTC');
    expect(dayOfYear[0]).toBe(365);
    expect(year[0]).toBe(2020);
    expect(Number.isNaN(year[1])).toBe(true);
    expect(Number.isNaN(dayOfYear[1])).toBe(true);
  });

  it('falls back to UTC for an unknown zone', () => {
    const { year } = calendarFields(new Float64Array([ms('2020-12-31T23:00:00Z')]), 'Not/AZone');
    expect(year[0]).toBe(2020);
  });

  it('handles the rainfall record: one row per local day, 09:00 readings', () => {
    const text = readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8');
    const col = parseCsv(text).table.columns.find((c) => c.name === 'Observation time UTC') as TimeColumn;
    const t0 = performance.now();
    const { year, dayOfYear } = calendarFields(col.values, 'Pacific/Auckland');
    const elapsed = performance.now() - t0;
    expect(year[0]).toBe(1879);
    expect(year[year.length - 1]).toBe(1997);
    // No two rows fall on the same local day.
    const keys = new Set<number>();
    for (let i = 0; i < year.length; i++) keys.add(year[i]! * 400 + dayOfYear[i]!);
    expect(keys.size).toBe(year.length);
    expect(elapsed).toBeLessThan(2000);
  });
});
