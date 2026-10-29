/**
 * Row filters: a layer's view of its dataset with only the rows that match its `filter`
 * conditions (see RowFilterSchema). Pure and worker-safe; the windows run it once per filter
 * change, never per frame.
 *
 * The kept rows are copied in their file order, untouched: missing values stay missing, and
 * category columns keep their whole dictionary, so a value's code (and its colour) is the same
 * whichever rows a layer keeps. Min, max and null counts are worked out again from the kept rows,
 * so domains fit what the layer shows. Time cadences are detected again too (a long table that
 * repeats each year per series has a yearly step once one series is kept).
 */

import type { CalendarFields } from './calendar.ts';
import type { Column, Table } from './columns.ts';
import { type Cadence, detectCadence } from './gaps.ts';
import type { RowFilter } from '../shared/layer-schema.ts';

/** A row filter that cannot run (its column is missing or holds numbers or times). */
export class RowFilterError extends Error {}

/** Stable text of a filter list, for structure keys and caches ('' for no filter). */
export function filterKey(filter: readonly RowFilter[]): string {
  return filter.length === 0 ? '' : JSON.stringify(filter.map((f) => [f.column, f.values]));
}

/** Columns a filter can use: category and text columns that hold at least one value. */
export function filterable(column: Column): boolean {
  return (column.type === 'category' || column.type === 'text') && !column.empty;
}

/** Per-row test for one condition. */
function matcher(table: Table, f: RowFilter): (row: number) => boolean {
  const column = table.columns.find((c) => c.name === f.column);
  if (!column) throw new RowFilterError(`filter column "${f.column}" is not in the dataset`);
  const wanted = new Set(f.values);
  if (column.type === 'category') {
    // Compare codes, not strings: one lookup per dictionary entry.
    const keep = new Uint8Array(column.dictionary.length);
    column.dictionary.forEach((v, i) => (keep[i] = wanted.has(v) ? 1 : 0));
    const codes = column.codes;
    return (row) => {
      const code = codes[row]!;
      return code >= 0 && keep[code] === 1;
    };
  }
  if (column.type === 'text') {
    const values = column.values;
    return (row) => {
      const v = values[row];
      return v !== null && v !== undefined && wanted.has(v);
    };
  }
  throw new RowFilterError(`filter column "${f.column}" holds ${column.type}s; filters use category or text columns`);
}

/** Indices of the rows that pass every condition, in file order. */
export function filterRows(table: Table, filter: readonly RowFilter[]): Int32Array {
  const tests = filter.map((f) => matcher(table, f));
  const out = new Int32Array(table.rowCount);
  let n = 0;
  for (let row = 0; row < table.rowCount; row++) if (tests.every((t) => t(row))) out[n++] = row;
  return out.slice(0, n);
}

function pick<T extends Float32Array | Float64Array | Int32Array>(src: T, rows: Int32Array, out: T): T {
  for (let i = 0; i < rows.length; i++) out[i] = src[rows[i]!]!;
  return out;
}

/** Min, max and missing count of kept numbers (NaN counts as missing), in float64. */
function stats(values: Float32Array | Float64Array): { min: number; max: number; nullCount: number } {
  let min = Infinity;
  let max = -Infinity;
  let nullCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) nullCount++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return nullCount === values.length ? { min: NaN, max: NaN, nullCount } : { min, max, nullCount };
}

function subsetColumn(c: Column, rows: Int32Array): Column {
  const n = rows.length;
  switch (c.type) {
    case 'number': {
      const values = pick(c.values, rows, new Float32Array(n));
      return { ...c, length: n, values, ...stats(values) };
    }
    case 'time': {
      const values = pick(c.values, rows, new Float64Array(n));
      return { ...c, length: n, values, ...stats(values) };
    }
    case 'category': {
      const codes = pick(c.codes, rows, new Int32Array(n));
      let nullCount = 0;
      for (let i = 0; i < n; i++) if (codes[i]! < 0) nullCount++;
      return { ...c, length: n, codes, nullCount };
    }
    case 'text': {
      const values = Array.from(rows, (r) => c.values[r] ?? null);
      return { ...c, length: n, values, nullCount: values.reduce((k, v) => (v === null ? k + 1 : k), 0) };
    }
  }
}

/** The table with only `rows` (indices into it, in the order given). */
export function subsetTable(table: Table, rows: Int32Array): Table {
  return { rowCount: rows.length, columns: table.columns.map((c) => subsetColumn(c, rows)) };
}

/** What a layer reads from a parsed dataset (the output's LoadedDataset carries more). */
export interface FilterableData {
  table: Table;
  cadences: Record<string, Cadence>;
  calendars: Record<string, CalendarFields>;
}

/**
 * The dataset as a layer with `filter` sees it. With no conditions it is `data` itself (no
 * copy). Throws RowFilterError when a condition cannot run or no row is kept, so the layer is
 * flagged with the reason instead of drawing nothing.
 */
export function applyRowFilter<D extends FilterableData>(data: D, filter: readonly RowFilter[]): D {
  if (filter.length === 0) return data;
  const rows = filterRows(data.table, filter);
  if (rows.length === 0) throw new RowFilterError(`the row filter keeps none of the ${data.table.rowCount} rows`);
  const table = subsetTable(data.table, rows);
  const cadences: Record<string, Cadence> = {};
  for (const name of Object.keys(data.cadences)) {
    const c = table.columns.find((col) => col.name === name);
    if (c?.type === 'time') cadences[name] = detectCadence(c.values);
  }
  const calendars: Record<string, CalendarFields> = {};
  for (const [name, cal] of Object.entries(data.calendars)) {
    calendars[name] = { year: pick(cal.year, rows, new Float32Array(rows.length)), dayOfYear: pick(cal.dayOfYear, rows, new Float32Array(rows.length)) };
  }
  return { ...data, table, cadences, calendars };
}
