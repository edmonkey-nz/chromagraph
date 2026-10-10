import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getColumn, type Column } from '../../src/data/columns.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { cellFormatter, columnChars, sortRows } from '../../src/data/table-view.ts';

const FULL = fs.readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8');
const table = parseCsv(FULL).table;
const lines = FULL.replace(/^﻿/, '').split(/\r\n/).filter((l) => l.length > 0);
const header = lines[0]!.split(',');
const raw = (row: number, name: string) => lines[row + 1]!.split(',')[header.indexOf(name)]!;

function col(name: string): Column {
  const c = getColumn(table, name);
  if (!c) throw new Error(`missing column ${name}`);
  return c;
}

describe('row viewer cells', () => {
  it("show numbers with the column's decimals (as text layers do), and missing as null", () => {
    const c = col('Rainfall [mm]');
    if (c.type !== 'number') throw new Error('expected a number column');
    expect(c.decimals).toBe(1);
    const f = cellFormatter(c, 'Pacific/Auckland');
    for (let row = 0; row < 500; row++) {
      const text = raw(row, 'Rainfall [mm]');
      expect(f(row), `row ${row + 1}`).toBe(text === '' ? null : Number(text).toFixed(1));
    }
    const deficit = cellFormatter(col('Deficit [mm]'), 'UTC');
    expect(deficit(0)).toBeNull(); // the water balance columns start empty
  });

  it('show times in the dataset timezone, padded (NZ Mean Time before 1941)', () => {
    const time = col('Observation time UTC');
    expect(cellFormatter(time, 'Pacific/Auckland')(0)).toBe('02 Jan 1879 08:30');
    expect(cellFormatter(time, 'UTC')(0)).toBe('01 Jan 1879 21:00');
    expect(cellFormatter(time, 'Not/AZone')(0)).toBe('01 Jan 1879 21:00'); // falls back to UTC
  });

  it('show categories and text as written', () => {
    const f = cellFormatter(col('Data Source (rainfall)'), 'UTC');
    expect(f(0)).toBe(raw(0, 'Data Source (rainfall)'));
    const text: Column = { type: 'text', name: 't', index: 0, length: 2, nullCount: 1, empty: false, min: NaN, max: NaN, values: ['a', null] };
    expect(cellFormatter(text, 'UTC')(0)).toBe('a');
    expect(cellFormatter(text, 'UTC')(1)).toBeNull();
  });
});

describe('row viewer sort', () => {
  it('orders numbers both ways with missing last and ties in file order', () => {
    const c = col('Rainfall [mm]');
    if (c.type !== 'number') throw new Error('expected a number column');
    for (const dir of ['asc', 'desc'] as const) {
      const order = sortRows(c, table.rowCount, dir);
      expect(order.length).toBe(table.rowCount);
      let seenMissing = false;
      for (let i = 1; i < order.length; i++) {
        const a = c.values[order[i - 1]!]!;
        const b = c.values[order[i]!]!;
        if (Number.isNaN(b)) {
          seenMissing = true;
          if (Number.isNaN(a)) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
          continue;
        }
        expect(seenMissing).toBe(false);
        if (a === b) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
        else expect(dir === 'asc' ? a < b : a > b).toBe(true);
      }
    }
    expect(c.values[sortRows(c, table.rowCount, 'desc')[0]!]).toBeCloseTo(215.9, 3);
  });

  it('orders categories and text by their words, numbers inside them numerically', () => {
    const cat: Column = { type: 'category', name: 'c', index: 0, length: 5, nullCount: 1, empty: false, min: NaN, max: NaN, codes: Int32Array.from([0, 1, -1, 2, 0]), dictionary: ['b10', 'a', 'b9'] };
    expect([...sortRows(cat, 5, 'asc')]).toEqual([1, 3, 0, 4, 2]);
    expect([...sortRows(cat, 5, 'desc')]).toEqual([0, 4, 3, 1, 2]);
    const text: Column = { type: 'text', name: 't', index: 0, length: 4, nullCount: 1, empty: false, min: NaN, max: NaN, values: ['pear', null, 'Apple', 'fig'] };
    expect([...sortRows(text, 4, 'asc')]).toEqual([2, 3, 0, 1]);
  });
});

describe('row viewer column widths', () => {
  it('fit the header or the widest sampled value, within limits', () => {
    const time = col('Observation time UTC');
    expect(columnChars(time, table.rowCount, cellFormatter(time, 'UTC'))).toBe('Observation time UTC'.length + 2);
    const rain = col('Rainfall [mm]');
    expect(columnChars(rain, table.rowCount, () => 'x'.repeat(100))).toBe(40);
  });
});
