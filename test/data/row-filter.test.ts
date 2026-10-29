import { describe, expect, it } from 'vitest';
import type { CategoryColumn, NumberColumn, TextColumn } from '../../src/data/columns.ts';
import { calendarFields } from '../../src/data/calendar.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { applyRowFilter, filterKey, filterRows, RowFilterError } from '../../src/data/row-filter.ts';
import { summarise } from '../../src/shared/layer-defaults.ts';
import { blankLineLayer, LayerSchema } from '../../src/shared/layer-schema.ts';

// A long table in the shape of the "Over time, by sex" download: two statuses × two sexes per year.
const CSV = [
  '"Data status","year","Sex","number","note","when"',
  '"Confirmed",2009,"Female","118","a","2009-01-01T00:00:00Z"',
  '"Confirmed",2009,"Male","396","b","2009-01-01T00:00:00Z"',
  '"Confirmed",2010,"Female","147",,"2010-01-01T00:00:00Z"',
  '"Confirmed",2010,"Male","","b","2010-01-01T00:00:00Z"',
  '"Confirmed",2011,"Female","150","a","2011-01-01T00:00:00Z"',
  '"Confirmed",2011,"Male","401","c","2011-01-01T00:00:00Z"',
  '"Suspected",2009,"Female","120","d","2009-01-01T00:00:00Z"',
  '"Suspected",2009,"Male","400","e","2009-01-01T00:00:00Z"',
  '"Suspected",2010,"Female","149","f","2010-01-01T00:00:00Z"',
  '"Suspected",2010,"Male","390","g","2010-01-01T00:00:00Z"',
  '"Suspected",2011,"Female","151","h","2011-01-01T00:00:00Z"',
  '"Suspected",2011,"Male","405","i","2011-01-01T00:00:00Z"',
].join('\n');

const { table } = parseCsv(CSV);
const when = table.columns.find((c) => c.name === 'when');
if (when?.type !== 'time') throw new Error('fixture: "when" should parse as time');
const data = {
  table,
  cadences: { when: detectCadence(when.values) },
  calendars: { when: calendarFields(when.values, 'Pacific/Auckland') },
  version: 7,
};
const col = <T>(t: typeof table, name: string) => t.columns.find((c) => c.name === name) as T;

describe('row filter', () => {
  it('the fixture parses Sex and Data status as categories', () => {
    expect(col<CategoryColumn>(table, 'Sex').type).toBe('category');
    expect(col<CategoryColumn>(table, 'Data status').type).toBe('category');
  });

  it('no conditions: the dataset itself, uncopied', () => {
    expect(applyRowFilter(data, [])).toBe(data);
    expect(filterKey([])).toBe('');
  });

  it('keeps matching rows in file order; conditions are ANDed, values ORed', () => {
    expect([...filterRows(table, [{ column: 'Sex', values: ['Male'] }])]).toEqual([1, 3, 5, 7, 9, 11]);
    expect([...filterRows(table, [{ column: 'Sex', values: ['Male'] }, { column: 'Data status', values: ['Confirmed'] }])]).toEqual([1, 3, 5]);
    expect([...filterRows(table, [{ column: 'Sex', values: ['Male', 'Female'] }])]).toHaveLength(12);
    expect([...filterRows(table, [{ column: 'Sex', values: [] }])]).toEqual([]);
  });

  it('copies the kept rows untouched: missing stays missing, stats come from the kept rows', () => {
    const view = applyRowFilter(data, [{ column: 'Sex', values: ['Male'] }, { column: 'Data status', values: ['Confirmed'] }]);
    expect(view.version).toBe(7);
    expect(view.table.rowCount).toBe(3);
    const n = col<NumberColumn>(view.table, 'number');
    expect([...n.values].map((v) => (Number.isNaN(v) ? 'NaN' : v))).toEqual([396, 'NaN', 401]);
    expect([n.min, n.max, n.nullCount]).toEqual([396, 401, 1]);
    expect(n.decimals).toBe(col<NumberColumn>(table, 'number').decimals);
    expect([...col<NumberColumn>(view.table, 'year').values]).toEqual([2009, 2010, 2011]);
    // The dictionary is kept whole, so codes (and categorical colours) match the full table.
    const sex = col<CategoryColumn>(view.table, 'Sex');
    expect(sex.dictionary).toEqual(col<CategoryColumn>(table, 'Sex').dictionary);
    expect(new Set(sex.codes)).toEqual(new Set([sex.dictionary.indexOf('Male')]));
    // The source is not modified.
    expect(table.rowCount).toBe(12);
  });

  it('text columns match exactly; missing never matches', () => {
    const note = col<TextColumn>(table, 'note');
    expect(note.type).toBe('text');
    expect([...filterRows(table, [{ column: 'note', values: ['a', 'b'] }])]).toEqual([0, 1, 3, 4]);
    expect([...filterRows(table, [{ column: 'note', values: [''] }])]).toEqual([]);
  });

  it('re-detects cadence and slices calendar fields for the kept rows', () => {
    // The whole table repeats each year, so most deltas are not positive.
    expect(data.cadences.when.nonMonotonic).toBeGreaterThan(0);
    const view = applyRowFilter(data, [{ column: 'Sex', values: ['Female'] }, { column: 'Data status', values: ['Suspected'] }]);
    expect(view.cadences.when!.nonMonotonic).toBe(0);
    expect(view.cadences.when!.gaps).toEqual([]);
    expect([...view.calendars.when!.year]).toEqual([2009, 2010, 2011]);
  });

  it('fails clearly when it cannot run or keeps nothing', () => {
    expect(() => applyRowFilter(data, [{ column: 'Nope', values: ['x'] }])).toThrow(RowFilterError);
    expect(() => applyRowFilter(data, [{ column: 'number', values: ['396'] }])).toThrow(/category or text/);
    expect(() => applyRowFilter(data, [{ column: 'Sex', values: ['Other'] }])).toThrow(/keeps none of the 12 rows/);
  });

  it('summaries list the choices: category dictionaries and short text columns', () => {
    const s = summarise(table, data.cadences);
    expect(s.columns.find((c) => c.name === 'Sex')?.values).toEqual(['Female', 'Male']);
    expect(s.columns.find((c) => c.name === 'note')?.values).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(s.columns.find((c) => c.name === 'number')?.values).toBeUndefined();
  });

  it('the layer schema takes a filter and blank layers start with none', () => {
    const l = blankLineLayer('l', 'L', 'ds');
    expect(l.filter).toEqual([]);
    expect(LayerSchema.safeParse({ ...l, filter: [{ column: 'Sex', values: ['Male'] }] }).success).toBe(true);
    expect(LayerSchema.safeParse({ ...l, filter: [{ column: '', values: [] }] }).success).toBe(false);
  });
});
