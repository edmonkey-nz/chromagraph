import { describe, expect, it } from 'vitest';
import type { Column } from '../../src/data/columns.ts';
import { inferColumn, parseIsoTime } from '../../src/data/infer.ts';

function infer(raw: (string | undefined)[]) {
  return inferColumn('c', 0, raw);
}

function expectType<T extends Column['type']>(c: Column, type: T): Extract<Column, { type: T }> {
  expect(c.type).toBe(type);
  return c as Extract<Column, { type: T }>;
}

describe('missing values', () => {
  it('treats undefined, empty and whitespace-only as missing, nothing else', () => {
    const { column } = infer(['NA', undefined, '', '  ', '\t', 'null', '-', 'NA', 'null', '-', 'NA', 'NA']);
    const c = expectType(column, 'category');
    expect(c.nullCount).toBe(4);
    expect(c.dictionary).toEqual(['NA', 'null', '-']);
    expect(Array.from(c.codes)).toEqual([0, -1, -1, -1, -1, 1, 2, 0, 1, 2, 0, 0]);
  });

  it('types a fully empty column as an empty number column', () => {
    const { column, issues } = infer(['', undefined, ' ']);
    const c = expectType(column, 'number');
    expect(c.empty).toBe(true);
    expect(c.nullCount).toBe(3);
    expect(c.length).toBe(3);
    expect(Array.from(c.values).every(Number.isNaN)).toBe(true);
    expect(c.min).toBeNaN();
    expect(c.max).toBeNaN();
    expect(issues).toEqual([]);
  });
});

describe('numbers', () => {
  it('accepts signs, fractions, leading-dot fractions and exponents', () => {
    const raw = ['-1.5', '+2', '.5', '-.25', '1e3', '-2.5E-3', '7.', ' 42 ', '0', ''];
    const c = expectType(infer(raw).column, 'number');
    expect(c.empty).toBe(false);
    expect(c.nullCount).toBe(1);
    expect(Array.from(c.values.subarray(0, 9))).toEqual(
      [-1.5, 2, 0.5, -0.25, 1000, -0.0025, 7, 42, 0].map(Math.fround),
    );
    expect(c.values[9]).toBeNaN();
    expect(c.min).toBe(-1.5);
    expect(c.max).toBe(1000);
  });

  it('keeps a low-cardinality numeric column as number', () => {
    expect(infer(['1', '1', '1', '2', '2', '1']).column.type).toBe('number');
  });

  it.each([['NaN'], ['Infinity'], ['-Infinity'], ['0x1F'], ['1,000'], ['5 mm'], ['1e'], ['.'], ['+'], ['1e400']])(
    'rejects %s as a number',
    (bad) => {
      expect(infer(['1', '2', bad]).column.type).not.toBe('number');
    },
  );

  it('stores float32 values but computes min/max in float64', () => {
    const c = expectType(infer(['0.1', '16777217', '3.3']).column, 'number');
    expect(c.values[0]).toBe(Math.fround(0.1));
    expect(c.values[0]).not.toBe(0.1);
    expect(c.values[1]).toBe(16777216); // float32 cannot hold 2^24 + 1
    expect(c.min).toBe(0.1);
    expect(c.max).toBe(16777217);
  });

  it('warns when values overflow float32', () => {
    const { column, issues } = infer(['1', '1e39']);
    const c = expectType(column, 'number');
    expect(c.values[1]).toBe(Infinity);
    expect(c.max).toBe(1e39);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/float32/);
  });

  it('does not coerce a mostly-numeric column with a stray "n/a", and says why', () => {
    const raw: string[] = [];
    for (let i = 0; i < 40; i++) raw.push(String(i * 1.5));
    raw[13] = 'n/a';
    const { column, issues } = inferColumn('Rainfall [mm]', 3, raw);
    expect(column.type).not.toBe('number');
    const c = expectType(column, 'text');
    expect(c.values[13]).toBe('n/a');
    expect(c.values[0]).toBe('0');
    expect(issues).toHaveLength(1);
    const w = issues[0]!;
    expect(w.severity).toBe('warning');
    expect(w.column).toBe('Rainfall [mm]');
    expect(w.message).toContain('Rainfall [mm]');
    expect(w.message).toContain('1 of 40');
    expect(w.message).toContain('"n/a" at row 14');
    expect(w.message).toContain('text');
  });

  it('lists at most three examples in the mostly-numeric warning', () => {
    const raw: string[] = [];
    for (let i = 0; i < 100; i++) raw.push(String(i));
    raw[5] = 'x';
    raw[6] = 'y';
    raw[7] = 'z';
    raw[8] = 'w';
    const { issues } = infer(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('4 of 100');
    expect(issues[0]!.message).toContain('"z" at row 8');
    expect(issues[0]!.message).not.toContain('"w"');
  });

  it('gives no mostly-numeric warning below 90%', () => {
    expect(infer(['1', '2', '3', '4', '5', '6', '7', '8', 'a', 'b']).issues).toEqual([]);
  });
});

describe('times', () => {
  it('parses Z, +hh:mm and +hhmm offsets', () => {
    const raw = ['2020-01-01T12:00:00Z', '2020-01-02T00:00:00+12:00', '2020-01-02T00:00+1300', '2020-01-01 06:30:15.5-05:30'];
    const { column, issues } = infer(raw);
    const c = expectType(column, 'time');
    expect(c.assumedUtc).toBe(false);
    expect(issues).toEqual([]);
    expect(Array.from(c.values)).toEqual([
      Date.UTC(2020, 0, 1, 12),
      Date.UTC(2020, 0, 1, 12),
      Date.UTC(2020, 0, 1, 11),
      Date.UTC(2020, 0, 1, 12, 0, 15, 500),
    ]);
    expect(c.min).toBe(Date.UTC(2020, 0, 1, 11));
    expect(c.max).toBe(Date.UTC(2020, 0, 1, 12, 0, 15, 500));
  });

  it('reads date-only and zoneless values as UTC with one warning', () => {
    const { column, issues } = inferColumn('day', 0, ['2020-03-01', '2020-03-02', '', '2020-03-03T10:00', '2020-03-04T00:00Z']);
    const c = expectType(column, 'time');
    expect(c.assumedUtc).toBe(true);
    expect(c.nullCount).toBe(1);
    expect(c.values[0]).toBe(Date.UTC(2020, 2, 1));
    expect(c.values[2]).toBeNaN();
    expect(c.values[3]).toBe(Date.UTC(2020, 2, 3, 10));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.column).toBe('day');
    expect(issues[0]!.message).toContain('3 of 4');
  });

  it('rejects an impossible calendar date', () => {
    expect(parseIsoTime('2020-02-30')).toBeNaN();
    expect(parseIsoTime('2019-02-29')).toBeNaN();
    expect(parseIsoTime('2020-02-29')).toBe(Date.UTC(2020, 1, 29));
    expect(parseIsoTime('1900-02-29')).toBeNaN();
    expect(parseIsoTime('2000-02-29')).toBe(Date.UTC(2000, 1, 29));
    const { column } = infer(['2020-02-28', '2020-02-29', '2020-02-30']);
    expect(column.type).not.toBe('time');
  });

  it.each([
    ['2020-13-01'], ['2020-00-10'], ['2020-01-00'], ['2020-01-01T24:00'], ['2020-01-01T12:60'],
    ['2020-01-01T12:00:60'], ['2020-1-01'], ['20200101'], ['2020-01-01T12'], ['2020-01-01Z'],
    ['2020-01-01T12:00+25:00'], ['2020-01-01T12:00:00.1234'], ['01/02/2020'], ['2020-01-01T12:00:00 Z'],
    ['2020-01-01T12:00:00.'], ['2020-01-01T12:00+12:0'], ['2020-01-01T12:00:00Zx'], ['2020-01-01T12:00+12:000'],
    ['2020-01-01x'], ['2020-01-01T'], ['2020-01-01T1:00'], ['+020-01-01'], ['2020-01-01T12:00:00+1'],
  ])('rejects %s', (s) => {
    expect(parseIsoTime(s)).toBeNaN();
  });

  it('handles years below 100 without the 1900 offset', () => {
    const t = parseIsoTime('0050-06-15T00:00:00Z');
    const d = new Date(t);
    expect(d.getUTCFullYear()).toBe(50);
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCDate()).toBe(15);
    expect(parseIsoTime('0004-02-29')).not.toBeNaN(); // leap year in the proleptic calendar
    expect(new Date(parseIsoTime('0000-01-01')).getUTCFullYear()).toBe(0);
    const c = expectType(infer(['0099-12-31T23:59:59Z', '0100-01-01T00:00:00Z']).column, 'time');
    expect(c.values[1]! - c.values[0]!).toBe(1000);
  });

  it('warns about a mostly-time column with a stray value', () => {
    const raw: string[] = [];
    for (let d = 1; d <= 20; d++) raw.push(`2021-01-${String(d).padStart(2, '0')}T00:00:00Z`);
    raw[4] = 'unknown';
    const { column, issues } = inferColumn('when', 0, raw);
    expect(column.type).toBe('text');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('mostly ISO time');
    expect(issues[0]!.message).toContain('"unknown" at row 5');
  });

  it('prefers number over time for bare years', () => {
    expect(infer(['2020', '2021']).column.type).toBe('number');
  });
});

describe('category and text', () => {
  it('builds a first-seen dictionary without trimming or case folding', () => {
    const c = expectType(infer(['b', 'a', 'B', 'b', ' a', 'a', 'b', 'a', 'B', '']).column, 'category');
    expect(c.dictionary).toEqual(['b', 'a', 'B', ' a']);
    expect(Array.from(c.codes)).toEqual([0, 1, 2, 0, 3, 1, 0, 1, 2, -1]);
    expect(c.min).toBeNaN();
    expect(c.max).toBeNaN();
  });

  it('turns a high-cardinality string column into text, verbatim', () => {
    const raw = Array.from({ length: 300 }, (_, i) => `id-${i} `);
    raw[7] = '';
    const c = expectType(infer(raw).column, 'text');
    expect(c.values[0]).toBe('id-0 ');
    expect(c.values[7]).toBeNull();
    expect(c.nullCount).toBe(1);
    expect(c.min).toBeNaN();
  });

  it('caps categories at 256 distinct values', () => {
    const raw: string[] = [];
    for (let rep = 0; rep < 4; rep++) for (let i = 0; i < 256; i++) raw.push(`k${i}`);
    expect(infer(raw).column.type).toBe('category');
    raw.push('k256', 'k256', 'k256');
    expect(infer(raw).column.type).toBe('text');
  });

  it('requires distinct values to be at most half the non-missing count', () => {
    expect(infer(['a', 'b', 'a', 'b']).column.type).toBe('category');
    expect(infer(['a', 'b', 'c', 'a', 'b']).column.type).toBe('text');
  });
});
