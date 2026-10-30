import { describe, expect, it } from 'vitest';
import type { NumberColumn } from '../../src/data/columns.ts';
import { parseCsv, parseJson, parseText } from '../../src/data/parse.ts';
import { DatasetSchema, migrate } from '../../src/shared/project-schema.ts';

// The ozone file's shape: one "NA" in an otherwise numeric column.
const CSV = ['date,ozone,low', '2023-03-15,251.3,246.3', '2023-03-14,NA,NA', '2023-03-13, - ,274.6', '2023-03-12,262.3,'].join('\n');
const col = (r: ReturnType<typeof parseCsv>, name: string) => r.table.columns.find((c) => c.name === name)!;

describe('treat as missing', () => {
  it('without markers, a stray "NA" makes the column text, and the warning offers it', () => {
    // 20 readings, one "NA" (row 6) and one "-" (row 13): mostly numeric.
    const lines = ['v', ...Array.from({ length: 22 }, (_, i) => (i === 5 ? 'NA' : i === 12 ? ' - ' : String(250 + i)))];
    const r = parseCsv(lines.join('\n'));
    expect(col(r, 'v').type).toBe('text');
    const warn = r.report.issues.find((i) => i.column === 'v' && i.markers)!;
    expect(warn.markers).toEqual(['NA', '-']);
    expect(warn.row).toBe(5);
    expect(col(parseCsv(lines.join('\n'), { missing: warn.markers }), 'v').type).toBe('number');
  });

  it('markers read as missing (trimmed, exact), so the column is numbers with gaps', () => {
    const r = parseCsv(CSV, { missing: ['NA', '-'] });
    const ozone = col(r, 'ozone') as NumberColumn;
    expect(ozone.type).toBe('number');
    expect([...ozone.values].map((v) => (Number.isNaN(v) ? null : v))).toEqual([Math.fround(251.3), null, null, Math.fround(262.3)]);
    expect(ozone.nullCount).toBe(2);
    expect(ozone.decimals).toBe(1);
    // Real empty cells stay missing too.
    expect((col(r, 'low') as NumberColumn).nullCount).toBe(2);
  });

  it('the report counts what each marker blanked, with rows', () => {
    const r = parseCsv(CSV, { missing: ['NA', '-'] });
    const notes = r.report.issues.filter((i) => i.message.includes('read as missing')).map((i) => i.message);
    expect(notes).toEqual([
      'Column "ozone": 1 cell "NA" read as missing (row 2).',
      'Column "ozone": 1 cell "-" read as missing (row 3).',
      'Column "low": 1 cell "NA" read as missing (row 2).',
    ]);
    expect(r.report.issues.some((i) => i.message.includes('mostly numeric'))).toBe(false);
  });

  it('matches whole cells only, never part of a value', () => {
    const r = parseCsv(['name', 'NA', 'NAN', 'North America'].join('\n'), { missing: ['NA'] });
    const c = col(r, 'name');
    expect(c.nullCount).toBe(1);
  });

  it('JSON and parseText take the markers too', () => {
    const j = parseJson(JSON.stringify([{ v: 1 }, { v: 'n/a' }, { v: 3 }]), { missing: ['n/a'] });
    expect(col(j, 'v').type).toBe('number');
    expect(col(parseText(CSV, 'x.csv', { missing: ['NA', '-'] }), 'ozone').type).toBe('number');
  });

  it('schema: datasets carry the list; older projects get an empty one', () => {
    expect(DatasetSchema.shape.missing.safeParse(['NA', '..']).success).toBe(true);
    expect(DatasetSchema.shape.missing.safeParse(['']).success).toBe(false);
    const r = migrate({
      version: 23, name: 'x', layers: [], parameters: {}, scenes: [],
      datasets: [{ id: 'd', file: 'a.csv', label: 'a', timeZone: 'UTC', source: '', url: '', attribution: '' }],
    });
    if (r.ok) expect(r.project.datasets[0]!.missing).toEqual([]);
  });
});
