import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/data/parse.ts';
import {
  bindTemplate,
  compileTemplate,
  creditLine,
  formatNumber,
  MISSING_TEXT,
  renderTemplate,
  sameCredits,
  templateRow,
  type TemplateCredits,
  type TemplateTable,
} from '../../src/shared/text-template.ts';

const TIME = 'Observation time UTC';
const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const NZ = 'Pacific/Auckland';

function render(src: string, row: number, t: TemplateTable | null = table, tz = NZ): string {
  return renderTemplate(bindTemplate(compileTemplate(src), t, tz), row);
}

describe('compileTemplate', () => {
  it('splits literals and fields', () => {
    expect(compileTemplate('Rain: {Rainfall [mm]|fixed:1} mm').parts).toEqual([
      { kind: 'text', text: 'Rain: ' },
      { kind: 'field', column: 'Rainfall [mm]', formats: ['fixed:1'] },
      { kind: 'text', text: ' mm' },
    ]);
  });

  it('escapes braces and leaves unmatched braces literal', () => {
    expect(render('{{x}} {{', 0)).toBe('{x} {');
    expect(render('a { b', 0)).toBe('a { b');
    expect(render('a } b', 0)).toBe('a } b');
    expect(render('{ {Rainfall [mm]}', 0)).toBe('{ 0.0'); // as written in the CSV
  });
});

describe('renderTemplate on the rainfall record', () => {
  it('formats dates in the dataset timezone', () => {
    // 1879-01-01T21:00Z is 08:30 on 2 Jan in NZ Mean Time (+11:30).
    expect(render(`{${TIME}|date}`, 0)).toBe('02 Jan 1879');
    expect(render(`{${TIME}|datetime}`, 0)).toBe('02 Jan 1879 08:30');
    expect(render(`{${TIME}}`, 0)).toBe('02 Jan 1879 08:30');
    expect(render(`{${TIME}|time}`, 0)).toBe('08:30');
    expect(render(`{${TIME}|year}`, 0)).toBe('1879');
    expect(render(`{${TIME}|month}`, 0)).toBe('January');
    expect(render(`{${TIME}|month|upper}`, 0)).toBe('JANUARY');
    expect(render(`{${TIME}|date}`, 0, table, 'UTC')).toBe('01 Jan 1879');
    expect(render(`{${TIME}|time}`, 0, table, 'Not/AZone')).toBe('21:00');
  });

  it('formats numbers', () => {
    const row = table.columns.find((c) => c.name === TIME)!;
    const i = (row as { values: Float64Array }).values.indexOf(Date.parse('1928-02-13T21:00:00Z'));
    expect(render('{Deficit [mm]}', i)).toBe('142.1');
    expect(render('{Deficit [mm]|fixed:2}', i)).toBe('142.10');
    expect(render('{Deficit [mm]|int}', i)).toBe('142');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(12.300000190734863)).toBe('12.3');
  });

  it('renders categories and upper case', () => {
    expect(render('{Data Source (rainfall)}', 0)).toBe('D');
    expect(render('{Frequency [D/H]|upper}', 0)).toBe('D');
  });

  it('renders missing values as an em dash, never NaN or 0', () => {
    expect(render('{Deficit [mm]}', 0)).toBe(MISSING_TEXT);
    expect(render('{Deficit [mm]|fixed:1}', 0)).toBe(MISSING_TEXT);
    expect(render('{Deficit [mm]|int}', 0)).toBe(MISSING_TEXT);
    expect(render('{Data source (water balance)}', 0)).toBe(MISSING_TEXT);
    expect(render('{Rainfall [mm]}', 999_999)).toBe(MISSING_TEXT);
  });

  it('makes mistakes visible', () => {
    expect(render('{Nope}', 0)).toBe('{?Nope}');
    expect(render('{Nope|date}', 0)).toBe('{?Nope|date}');
    expect(render(`{${TIME}|fixed:2}`, 0)).toBe(`{${TIME}|?fixed:2}`);
    expect(render('{Rainfall [mm]|date}', 0)).toBe('{Rainfall [mm]|?date}');
    expect(render('{Rainfall [mm]|bogus}', 0)).toBe('{Rainfall [mm]|?bogus}');
  });

  it('shows only static text without a dataset', () => {
    const bound = bindTemplate(compileTemplate('Rain {Rainfall [mm]} mm'), null, NZ);
    expect(bound.dynamic).toBe(false);
    expect(renderTemplate(bound, 0)).toBe('Rain {?Rainfall [mm]} mm');
    expect(bindTemplate(compileTemplate('{Rainfall [mm]}'), table, NZ).dynamic).toBe(true);
  });
});

describe('dataset credits', () => {
  const niwa: TemplateCredits = { source: 'NIWA CliFlo', url: 'https://cliflo.niwa.co.nz', attribution: '© NIWA, CC BY 4.0' };
  const none: TemplateCredits = { source: '', url: '', attribution: '' };
  const credit = (src: string, credits: TemplateCredits | null, t: TemplateTable | null = table, loading = false) =>
    renderTemplate(bindTemplate(compileTemplate(src), t, NZ, { credits, loading }), 0);

  it('shows each field as typed (trimmed)', () => {
    expect(credit('{@source}', niwa)).toBe('NIWA CliFlo');
    expect(credit('{@url}', niwa)).toBe('https://cliflo.niwa.co.nz');
    expect(credit('{@attribution}', niwa)).toBe('© NIWA, CC BY 4.0');
    expect(credit('Data: {@source}', { ...none, source: '  NIWA  ' })).toBe('Data: NIWA');
    expect(credit('{@source|upper}', niwa)).toBe('NIWA CLIFLO');
  });

  it('composes the credit line from the non-empty parts', () => {
    expect(creditLine(niwa)).toBe('Source: NIWA CliFlo · © NIWA, CC BY 4.0');
    expect(creditLine({ ...niwa, attribution: '' })).toBe('Source: NIWA CliFlo');
    expect(creditLine({ ...niwa, source: ' ' })).toBe('© NIWA, CC BY 4.0');
    expect(creditLine({ ...none, url: 'https://cliflo.niwa.co.nz' })).toBe(''); // the link is not part of it
    expect(creditLine(none)).toBe('');
    expect(creditLine(null)).toBe('');
    expect(credit('{@credit}', niwa)).toBe('Source: NIWA CliFlo · © NIWA, CC BY 4.0');
  });

  it('renders empty credits and no dataset as nothing, not the dash', () => {
    expect(credit('[{@source}{@url}{@attribution}{@credit}]', none)).toBe('[]');
    expect(credit('[{@source}{@url}{@attribution}{@credit}]', null, null)).toBe('[]');
  });

  it('is static text, even with a dataset', () => {
    const bound = bindTemplate(compileTemplate('{@credit}'), table, NZ, { credits: niwa });
    expect(bound.dynamic).toBe(false);
    expect(bound.pieces).toEqual(['Source: NIWA CliFlo · © NIWA, CC BY 4.0']);
  });

  it('keeps mistakes visible as for columns', () => {
    expect(credit('{@nope}', niwa)).toBe('{?@nope}');
    expect(credit('{@nope|upper}', niwa, null)).toBe('{?@nope|upper}');
    expect(credit('{@source|date}', niwa)).toBe('{@source|?date}');
    expect(credit('{@Source}', niwa)).toBe('{?@Source}'); // names are case-sensitive, like columns
  });

  it('leaves column fields alone, including columns named with "@"', () => {
    expect(credit('{Rainfall [mm]} {@source}', niwa)).toBe('0.0 NIWA CliFlo');
    const at: TemplateTable = { rowCount: 1, columns: [{ name: '@station', type: 'text', values: ['Taita'] }] };
    expect(credit('{@station} {@source}', niwa, at)).toBe('Taita NIWA CliFlo');
  });

  it('shows column fields as the dash while the dataset loads', () => {
    expect(credit('{Rainfall [mm]} · {@source}', niwa, null, true)).toBe(`${MISSING_TEXT} · NIWA CliFlo`);
    expect(credit('{Rainfall [mm]}', niwa, null, false)).toBe('{?Rainfall [mm]}');
  });

  it('compares credits by their text', () => {
    expect(sameCredits(niwa, { ...niwa })).toBe(true);
    expect(sameCredits(niwa, { ...niwa, url: '' })).toBe(false);
    expect(sameCredits(null, null)).toBe(true);
    expect(sameCredits(niwa, null)).toBe(false);
  });
});

describe('templateRow', () => {
  it('is round(row x (rowCount - 1)), clamped', () => {
    expect(templateRow(0, 42_748)).toBe(0);
    expect(templateRow(1, 42_748)).toBe(42_747);
    expect(templateRow(0.5, 11)).toBe(5);
    expect(templateRow(0.04, 11)).toBe(0);
    expect(templateRow(0.06, 11)).toBe(1);
    expect(templateRow(2, 11)).toBe(10);
    expect(templateRow(Number.NaN, 11)).toBe(0);
    expect(templateRow(0.5, 0)).toBe(0);
  });
});
