import { describe, expect, it } from 'vitest';
import { getColumn, tableTransferables, type Column, type ParseResult } from '../../src/data/columns.ts';
import { parseCsv, parseJson, parseText } from '../../src/data/parse.ts';

function col(r: ParseResult, name: string): Column {
  const c = getColumn(r.table, name);
  if (!c) throw new Error(`no column ${name}; have ${r.table.columns.map((x) => x.name).join(' | ')}`);
  return c;
}

function nums(c: Column): number[] {
  if (c.type !== 'number' && c.type !== 'time') throw new Error(`${c.name} is ${c.type}`);
  return Array.from(c.values);
}

function warnings(r: ParseResult): string[] {
  return r.report.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
}

function errors(r: ParseResult): string[] {
  return r.report.issues.filter((i) => i.severity === 'error').map((i) => i.message);
}

describe('parseCsv basics', () => {
  it('strips a BOM and gives identical results for CRLF and LF', () => {
    const lf = '﻿a,b\n1,x\n2,y\n3,x\n4,y\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parseCsv(lf);
    const b = parseCsv(crlf);
    expect(a.table.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(b.table.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(nums(col(a, 'a'))).toEqual([1, 2, 3, 4]);
    expect(nums(col(b, 'a'))).toEqual([1, 2, 3, 4]);
    const cat = col(b, 'b');
    expect(cat.type === 'category' && cat.dictionary).toEqual(['x', 'y']);
    expect(a.report).toEqual({ rowCount: 4, columnCount: 2, raggedRows: 0, issues: [] });
    expect(b.report).toEqual(a.report);
  });

  it('skips blank and whitespace-only lines', () => {
    const r = parseCsv('a,b\n\n1,2\n   \n\t\n3,4\n\n');
    expect(r.table.rowCount).toBe(2);
    expect(nums(col(r, 'b'))).toEqual([2, 4]);
    expect(r.report.issues).toEqual([]);
  });

  it('drops all-empty trailing-comma columns silently', () => {
    const r = parseCsv('a,b,,\n1,2,,\n3,4,,\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.report.columnCount).toBe(2);
    expect(r.report.raggedRows).toBe(0);
    expect(r.report.issues).toEqual([]);
  });

  it('tolerates rows that omit the dropped trailing-comma fields', () => {
    const r = parseCsv('a,b,\n1,2\n3,4,\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.report.raggedRows).toBe(0);
  });

  it('keeps a trailing unnamed column that has values, with a generated name and warning', () => {
    const r = parseCsv('a,b,\n1,2,\n3,4,x\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b', 'column 3']);
    const c = col(r, 'column 3');
    expect(c.type).toBe('text');
    expect(c.type === 'text' && c.values).toEqual([null, 'x']);
    expect(warnings(r).some((m) => m.includes('column 3') && m.includes('trailing comma'))).toBe(true);
  });

  it('names empty headers in the middle and warns', () => {
    const r = parseCsv('a,,c\n1,2,3\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'column 2', 'c']);
    expect(r.table.columns[1]!.index).toBe(1);
    expect(warnings(r)).toHaveLength(1);
    expect(warnings(r)[0]).toContain('column 2');
  });

  it('suffixes duplicate headers and warns', () => {
    const r = parseCsv('x,x,y,x\n1,2,3,4\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['x', 'x (2)', 'y', 'x (3)']);
    expect(nums(col(r, 'x (2)'))).toEqual([2]);
    expect(warnings(r)).toHaveLength(2);
    expect(warnings(r)[0]).toContain('"x (2)"');
  });

  it('avoids clashes between generated and real names', () => {
    const r = parseCsv('column 2,,a\n1,2,3\n');
    expect(r.table.columns.map((c) => c.name)).toEqual(['column 2', 'column 2 (2)', 'a']);
  });

  it('handles an empty column', () => {
    const r = parseCsv('a,empty,b\n1,,x\n2,,x\n3, ,y\n4,,y\n');
    const e = col(r, 'empty');
    expect(e.type).toBe('number');
    expect(e.empty).toBe(true);
    expect(e.nullCount).toBe(4);
    expect(nums(e).every(Number.isNaN)).toBe(true);
  });

  it('counts ragged rows (short and long) with one summary warning', () => {
    const r = parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8,9\n10\n11,12,13,\n');
    expect(r.table.rowCount).toBe(5);
    expect(r.report.raggedRows).toBe(4);
    expect(nums(col(r, 'a'))).toEqual([1, 4, 6, 10, 11]);
    expect(nums(col(r, 'b'))).toEqual([2, 5, 7, NaN, 12]);
    expect(nums(col(r, 'c'))).toEqual([3, NaN, 8, NaN, 13]);
    expect(r.table.columns).toHaveLength(3);
    const w = warnings(r);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('4 rows');
    expect(w[0]).toContain('2 with too few');
    expect(w[0]).toContain('2 with too many');
    expect(w[0]).toContain('1 of these rows had non-empty extra values');
    expect(w[0]).toContain('First rows: 2, 3, 4, 5');
  });

  it('lists only the first few ragged rows', () => {
    let csv = 'a,b\n';
    for (let i = 0; i < 50; i++) csv += `${i}\n`;
    const r = parseCsv(csv);
    expect(r.report.raggedRows).toBe(50);
    expect(warnings(r)).toHaveLength(1);
    expect(warnings(r)[0]).toContain('First rows: 1, 2, 3, 4, 5, …');
  });

  it('parses negative numbers and exponents', () => {
    const r = parseCsv('v\n-1\n2.5e3\n-4E-2\n+0.5\n');
    const c = col(r, 'v');
    expect(c.type).toBe('number');
    expect(nums(c)).toEqual([-1, 2500, -0.04, 0.5].map(Math.fround));
    expect(c.min).toBe(-1);
    expect(c.max).toBe(2500);
  });

  it('parses ISO times with offsets and date-only values', () => {
    const r = parseCsv('t,d\n2020-06-01T09:00:00+12:00,2020-06-01\n2020-12-01T09:00+1300,2020-06-02\n');
    const t = col(r, 't');
    expect(t.type === 'time' && t.assumedUtc).toBe(false);
    expect(nums(t)).toEqual([Date.UTC(2020, 4, 31, 21), Date.UTC(2020, 10, 30, 20)]);
    const d = col(r, 'd');
    expect(d.type === 'time' && d.assumedUtc).toBe(true);
    expect(nums(d)).toEqual([Date.UTC(2020, 5, 1), Date.UTC(2020, 5, 2)]);
    expect(warnings(r)).toHaveLength(1);
  });

  it('does not treat a column with 2020-02-30 as time', () => {
    const r = parseCsv('d\n2020-02-28\n2020-02-29\n2020-02-30\n2020-03-01\n');
    expect(col(r, 'd').type).not.toBe('time');
  });

  it('handles years below 100', () => {
    const r = parseCsv('t\n0001-01-01T00:00:00Z\n0099-07-04T12:00:00Z\n');
    const vals = nums(col(r, 't'));
    expect(new Date(vals[0]!).getUTCFullYear()).toBe(1);
    expect(new Date(vals[1]!).toISOString()).toBe('0099-07-04T12:00:00.000Z');
  });

  it('flags a stray "n/a" in a numeric column', () => {
    let csv = 'id,level\n';
    for (let i = 0; i < 30; i++) csv += `${i},${i === 17 ? 'n/a' : (i * 0.1).toFixed(1)}\n`;
    const r = parseCsv(csv);
    const c = col(r, 'level');
    expect(c.type).not.toBe('number');
    expect(c.type).toBe('text');
    const w = r.report.issues.find((i) => i.column === 'level');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('"level"');
    expect(w?.message).toContain('"n/a" at row 18');
  });

  it('keeps quoted values verbatim', () => {
    const r = parseCsv('name,n\n"Smith, J",1\n" padded ",2\n"a ""q""",3\n');
    const c = col(r, 'name');
    expect(c.type === 'text' && c.values).toEqual(['Smith, J', ' padded ', 'a "q"']);
  });

  it('accepts a header with zero data rows', () => {
    const r = parseCsv('a,b,c\n');
    expect(r.table.rowCount).toBe(0);
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(r.table.columns.every((c) => c.length === 0)).toBe(true);
    expect(errors(r)).toEqual([]);
  });

  it.each([[''], ['﻿'], ['  \r\n\n ']])('returns an error and an empty table for empty text %j', (text) => {
    const r = parseCsv(text);
    expect(r.table).toEqual({ rowCount: 0, columns: [] });
    expect(errors(r)).toHaveLength(1);
  });

  it('auto-detects tab and semicolon delimiters and says so', () => {
    for (const d of ['\t', ';']) {
      const r = parseCsv(`a${d}b\n1${d}2\n3${d}4\n`);
      expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b']);
      expect(warnings(r)).toHaveLength(1);
      expect(warnings(r)[0]).toContain(JSON.stringify(d));
    }
  });

  it('turns Papa errors into issues', () => {
    const r = parseCsv('a,b\n1,"unterminated\n2,3\n');
    expect(r.report.issues.some((i) => i.message.startsWith('CSV:'))).toBe(true);
  });

  it('does not throw for non-string input', () => {
    expect(() => parseCsv(undefined as unknown as string)).not.toThrow();
    expect(errors(parseCsv(null as unknown as string)).length).toBeGreaterThan(0);
  });

  it('exposes transferable buffers', () => {
    const r = parseCsv('a,b,c\n1,x,2020-01-01\n2,x,2020-01-02\n');
    expect(tableTransferables(r.table)).toHaveLength(3);
  });

  it('handles 100k rows × 8 columns comfortably', () => {
    const parts: string[] = ['t,a,b,c,d,cat,txt,e'];
    const t0 = Date.UTC(2000, 0, 1);
    for (let i = 0; i < 100_000; i++) {
      parts.push(
        `${new Date(t0 + i * 3_600_000).toISOString()},${i},${(i * 0.37).toFixed(2)},-${i % 97}e-2,${i % 13},` +
          `cat${i % 7},row ${i},`,
      );
    }
    const csv = parts.join('\r\n');
    const start = performance.now();
    const r = parseCsv(csv);
    const ms = performance.now() - start;
    expect(r.table.rowCount).toBe(100_000);
    expect(r.table.columns.map((c) => c.type)).toEqual(['time', 'number', 'number', 'number', 'number', 'category', 'text', 'number']);
    expect(col(r, 'e').empty).toBe(true);
    expect(ms).toBeLessThan(3000);
  });
});

describe('parseJson', () => {
  it('reads an array of records with the union of keys in first-seen order', () => {
    const r = parseJson(JSON.stringify([
      { a: 1, b: 'x' },
      { b: 'y', c: true },
      { a: null, c: false, b: 'x' },
      { a: 0.1, b: 'y' },
    ]));
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(r.table.rowCount).toBe(4);
    const a = col(r, 'a');
    expect(a.type).toBe('number');
    expect(nums(a)).toEqual([1, NaN, NaN, Math.fround(0.1)]);
    expect(a.max).toBe(1);
    expect(a.min).toBe(0.1);
    const b = col(r, 'b');
    expect(b.type === 'category' && b.dictionary).toEqual(['x', 'y']);
    const c = col(r, 'c');
    expect(c.nullCount).toBe(2);
    expect(r.report.raggedRows).toBe(0);
    expect(errors(r)).toEqual([]);
  });

  it('round-trips JSON numbers through String(n)', () => {
    const values = [0.1, 1e21, -5e-7, 123456789.123, 2 ** 53];
    const r = parseJson(JSON.stringify(values.map((v) => ({ v }))));
    const c = col(r, 'v');
    expect(c.type).toBe('number');
    expect(c.min).toBe(-5e-7);
    expect(c.max).toBe(1e21);
    expect(nums(c)).toEqual(values.map(Math.fround));
  });

  it('stringifies nested values with a warning', () => {
    const r = parseJson(JSON.stringify([{ a: 1, n: { x: 1 } }, { a: 2, n: [1, 2] }, { a: 3, n: 's' }]));
    const n = col(r, 'n');
    expect(n.type === 'text' && n.values).toEqual(['{"x":1}', '[1,2]', 's']);
    const w = r.report.issues.filter((i) => i.column === 'n');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('2 nested');
  });

  it('reports non-object entries in a records array', () => {
    const r = parseJson('[{"a":1},5,{"a":2}]');
    expect(r.table.rowCount).toBe(3);
    expect(nums(col(r, 'a'))).toEqual([1, NaN, 2]);
    expect(errors(r)).toHaveLength(1);
  });

  it('reads an object of equal-length column arrays', () => {
    const r = parseJson('{"t":["2020-01-01T00:00:00Z","2020-01-02T00:00:00Z"],"v":[1.5,null],"k":["a","a"]}');
    expect(r.table.rowCount).toBe(2);
    expect(r.table.columns.map((c) => [c.name, c.type])).toEqual([['t', 'time'], ['v', 'number'], ['k', 'category']]);
    expect(nums(col(r, 'v'))).toEqual([1.5, NaN]);
    expect(r.report.issues).toEqual([]);
  });

  it('pads unequal column arrays with missing values and reports it', () => {
    const r = parseJson('{"a":[1,2,3],"b":[4]}');
    expect(r.table.rowCount).toBe(3);
    expect(nums(col(r, 'b'))).toEqual([4, NaN, NaN]);
    expect(col(r, 'b').nullCount).toBe(2);
    const e = errors(r);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain('"b" (1)');
  });

  it('leaves out non-array members of a column object with an error', () => {
    const r = parseJson('{"a":[1,2],"meta":"x"}');
    expect(r.table.columns.map((c) => c.name)).toEqual(['a']);
    expect(r.report.issues.some((i) => i.severity === 'error' && i.column === 'meta')).toBe(true);
  });

  it.each([['{not json'], [''], ['42'], ['"str"'], ['null'], ['{"a":1}']])('returns an error for %j without throwing', (text) => {
    const r = parseJson(text);
    expect(r.table).toEqual({ rowCount: 0, columns: [] });
    expect(errors(r).length).toBeGreaterThan(0);
  });

  it('accepts an empty array as an empty table', () => {
    const r = parseJson('[]');
    expect(r.table).toEqual({ rowCount: 0, columns: [] });
    expect(errors(r)).toEqual([]);
  });

  it('strips a BOM before parsing', () => {
    expect(parseJson('﻿[{"a":1}]').table.rowCount).toBe(1);
  });
});

describe('parseText', () => {
  it('dispatches on extension', () => {
    expect(parseText('[{"a":1}]', 'data.JSON').table.rowCount).toBe(1);
    expect(parseText('a\n1\n2\n', 'data.csv').table.rowCount).toBe(2);
    expect(parseText('a\n1\n', 'notes.txt').table.columns[0]!.name).toBe('a');
    expect(errors(parseText('a\n1\n', 'x.json')).length).toBeGreaterThan(0);
  });
});
