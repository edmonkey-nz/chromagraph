import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getColumn, type Column, type TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv, parseText } from '../../src/data/parse.ts';

const FULL = fs.readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8');
const SAMPLE = fs.readFileSync(new URL('../fixtures/3384__Rain__daily-sample1.csv', import.meta.url), 'utf8');

const EXPECTED_TYPES: Record<string, Column['type']> = {
  'Frequency [D/H]': 'category',
  'Observation time UTC': 'time',
  'Data Source (rainfall)': 'category',
  'Rainfall [mm]': 'number',
  'PERIOD [hrs]': 'number',
  'Deficit [mm]': 'number',
  'Runoff [mm]': 'number',
  // Only T, D, M, F (plus blanks before 1928): low cardinality, so category.
  'Data source (water balance)': 'category',
};

function col(name: string, table = parsed.table): Column {
  const c = getColumn(table, name);
  if (!c) throw new Error(`missing column ${name}`);
  return c;
}

/** Independent reading of the fixture: plain split, no Papa (the file has no quoted fields). */
const lines = FULL.replace(/^﻿/, '').split(/\r\n/).filter((l) => l.length > 0);
const headerFields = lines[0]!.split(',');
const dataLines = lines.slice(1).map((l) => l.split(','));

const parsed = parseCsv(FULL);

describe('NIWA daily rainfall fixture', () => {
  it('is what the tests assume (BOM + CRLF, no quotes)', () => {
    expect(FULL.charCodeAt(0)).toBe(0xfeff);
    expect(FULL.includes('\r\n')).toBe(true);
    expect(FULL.includes('"')).toBe(false);
  });

  it('has 42,748 rows and 8 columns with BOM stripped from the first name', () => {
    expect(parsed.table.rowCount).toBe(42748);
    expect(dataLines.length).toBe(42748);
    expect(parsed.report.rowCount).toBe(42748);
    expect(parsed.table.columns.length).toBe(8);
    expect(parsed.report.columnCount).toBe(8);
    expect(parsed.report.raggedRows).toBe(0);
    expect(parsed.table.columns[0]!.name).toBe('Frequency [D/H]');
    expect(parsed.table.columns.map((c) => c.name)).toEqual(headerFields);
    expect(parsed.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('infers the expected column types', () => {
    for (const [name, type] of Object.entries(EXPECTED_TYPES)) {
      expect([name, col(name).type]).toEqual([name, type]);
    }
    for (const c of parsed.table.columns) expect(c.length).toBe(42748);
  });

  it('reads the time column as UTC with the right first and last values', () => {
    const t = col('Observation time UTC') as TimeColumn;
    expect(t.assumedUtc).toBe(false);
    expect(t.nullCount).toBe(0);
    expect(new Date(t.values[0]!).toISOString()).toBe('1879-01-01T21:00:00.000Z');
    expect(new Date(t.values[t.length - 1]!).toISOString()).toBe('1997-02-28T20:00:00.000Z');
    expect(t.min).toBe(Date.UTC(1879, 0, 1, 21));
    expect(t.max).toBe(Date.UTC(1997, 1, 28, 20));
  });

  it('matches independently computed rainfall min, max and null count', () => {
    const idx = headerFields.indexOf('Rainfall [mm]');
    let min = Infinity;
    let max = -Infinity;
    let nulls = 0;
    for (const f of dataLines) {
      const s = f[idx] ?? '';
      if (s.trim() === '') {
        nulls++;
        continue;
      }
      const v = Number(s);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const c = col('Rainfall [mm]');
    expect(c.min).toBe(min);
    expect(c.max).toBe(max);
    expect(c.nullCount).toBe(nulls);
    // Cross-checked with awk: min 0, max 215.9, no blanks.
    expect([min, max, nulls]).toEqual([0, 215.9, 0]);
  });

  it('has deficit and runoff empty before 1928 and present after', () => {
    const t = col('Observation time UTC') as TimeColumn;
    const cutoff = Date.UTC(1928, 0, 1);
    for (const name of ['Deficit [mm]', 'Runoff [mm]', 'Data source (water balance)']) {
      const c = col(name);
      const idx = headerFields.indexOf(name);
      const blanks = dataLines.filter((f) => (f[idx] ?? '') === '').length;
      expect(c.nullCount).toBe(blanks);
      expect(c.nullCount).toBeGreaterThan(10000);
      let firstPresent = -1;
      for (let i = 0; i < c.length; i++) {
        const missing = c.type === 'category' ? c.codes[i] === -1 : c.type === 'number' ? Number.isNaN(c.values[i]!) : true;
        if (!missing) {
          firstPresent = i;
          break;
        }
      }
      expect(firstPresent).toBeGreaterThan(0);
      expect(t.values[firstPresent]!).toBeGreaterThanOrEqual(cutoff);
    }
    const wb = col('Data source (water balance)');
    expect(wb.type === 'category' && [...wb.dictionary].sort()).toEqual(['D', 'F', 'M', 'T']);
  });

  /*
   * The brief expected every observation to be 09:00 in Pacific/Auckland. It is not:
   *   - 1879-1940: 21:00Z under NZ Mean Time (+11:30) is 08:30 local (and 09:30 under the
   *     1927-28 +12:30 summer time).
   *   - From 1974 onwards, rows during NZ daylight time (+13:00) are 20:00Z, others 21:00Z.
   * The true property is that the observation is 09:00 in modern NZ civil time: 09:00 at
   * +12:00 (21:00Z), or 09:00 at +13:00 (20:00Z) exactly when Auckland is on +13:00.
   * Every row from 1941 onwards is therefore 09:00 Pacific/Auckland.
   */
  it('observes at 09:00 NZ civil time (+12, or +13 during NZDT)', () => {
    const t = col('Observation time UTC') as TimeColumn;
    const hourFmt = new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'Pacific/Auckland',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const offsetFmt = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', timeZoneName: 'longOffset' });
    const from1941 = Date.UTC(1941, 0, 1);
    const localCounts: Record<string, number> = {};
    let bad = 0;
    for (let i = 0; i < t.length; i++) {
      const ms = t.values[i]!;
      const d = new Date(ms);
      const local = hourFmt.format(d);
      localCounts[local] = (localCounts[local] ?? 0) + 1;
      const nzdt = offsetFmt.format(d).endsWith('GMT+13:00');
      const expectedUtcHour = nzdt ? 20 : 21;
      if (d.getUTCHours() !== expectedUtcHour || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0) bad++;
      if (ms >= from1941 && local !== '09:00') bad++;
    }
    expect(bad).toBe(0);
    expect(localCounts).toEqual({ '08:30': 20108, '09:30': 119, '09:00': 19423 + 3098 });
  });

  it('has a one-day cadence with gaps in 1996/97 and no backwards steps', () => {
    const t = col('Observation time UTC') as TimeColumn;
    const cad = detectCadence(t.values);
    expect(cad.step).toBe(86_400_000);
    expect(cad.nonMonotonic).toBe(0);
    expect(cad.gaps.length).toBeGreaterThan(0);
    const late = cad.gaps.filter((g) => new Date(g.to).getUTCFullYear() >= 1996);
    expect(late.length).toBeGreaterThan(0);
    for (const g of cad.gaps) {
      expect(t.values[g.index]).toBe(g.to);
      expect(g.missingSteps).toBeGreaterThanOrEqual(1);
    }
    // Missing days across the record add up to the calendar span minus the rows present
    // (DST shifts of ±1 h round away).
    const totalMissing = cad.gaps.reduce((s, g) => s + g.missingSteps, 0);
    const spanDays = Math.round((t.max - t.min) / 86_400_000) + 1;
    expect(totalMissing).toBe(spanDays - t.length);
  });

  /*
   * The sample is LF (not CRLF) and is corrupt at data row 24: its last field is
   * "﻿Fr" (a stray BOM plus "Fr", apparently the start of another copy of the file).
   * That single non-missing value makes the water-balance column text (1 distinct value is
   * more than 50% of 1), and it must be kept verbatim. Every other type matches the full file.
   */
  it('parses the sample fixture to 49 rows with the same types (bar one corrupt cell)', () => {
    expect(SAMPLE.includes('\r')).toBe(false);
    const s = parseText(SAMPLE, '3384__Rain__daily-sample1.csv');
    expect(s.table.rowCount).toBe(49);
    expect(s.report.raggedRows).toBe(0);
    expect(s.table.columns.map((c) => c.name)).toEqual(headerFields);
    for (const [name, type] of Object.entries(EXPECTED_TYPES)) {
      if (name === 'Data source (water balance)') continue;
      expect([name, col(name, s.table).type]).toEqual([name, type]);
    }
    expect(col('Deficit [mm]', s.table).empty).toBe(true);
    const wb = col('Data source (water balance)', s.table);
    expect(wb.type).toBe('text');
    expect(wb.nullCount).toBe(48);
    if (wb.type === 'text') {
      expect(wb.values[23]).toBe('﻿Fr');
      expect(wb.values.filter((v) => v !== null)).toEqual(['﻿Fr']);
    }
  });

  it('parses the full file quickly', () => {
    const t0 = performance.now();
    parseCsv(FULL);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
