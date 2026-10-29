/**
 * Line split (LineSplitSchema): the rows of a dataset cut into one view per value of a
 * category or text column, so a line layer can draw one line per series. Pure and tested.
 *
 * Each view is the dataset filtered to one value (see row-filter.ts), then aligned with the
 * others: every number and time column takes the whole table's min and max (so auto domains,
 * and the time origin t = (time - min) / step, are shared), and every time column takes one
 * cadence step, the finest among the series. Values are taken in first-seen order (a category's
 * dictionary order, which is first-seen too), skipping values with no rows; missing values
 * belong to no series. A series' `index` is its value's position among all the column's values
 * (the whole dictionary for a category), so its default colour stays put when a filter drops
 * other values, and matches the control window's list.
 */

import type { Column } from './columns.ts';
import type { Cadence } from './gaps.ts';
import { applyRowFilter, type FilterableData, RowFilterError } from './row-filter.ts';
import { MAX_SPLIT } from '../shared/layer-schema.ts';

export interface Series<D extends FilterableData> {
  value: string;
  /** Position among the column's values (see above), for the default colour. */
  index: number;
  data: D;
}

/** Distinct values of a category or text column that occur, in first-seen order, with their index. */
export function seriesValues(column: Column): { value: string; index: number }[] {
  if (column.type === 'category') {
    const seen = new Uint8Array(column.dictionary.length);
    for (const code of column.codes) if (code >= 0) seen[code] = 1;
    return column.dictionary.map((value, index) => ({ value, index })).filter((v) => seen[v.index] === 1);
  }
  if (column.type === 'text') {
    const out = new Set<string>();
    for (const v of column.values) if (v !== null) out.add(v);
    return [...out].map((value, index) => ({ value, index }));
  }
  throw new RowFilterError(`split column "${column.name}" holds ${column.type}s; split by a category or text column`);
}

export function splitSeries<D extends FilterableData>(data: D, columnName: string): Series<D>[] {
  const column = data.table.columns.find((c) => c.name === columnName);
  if (!column) throw new RowFilterError(`split column "${columnName}" is not in the dataset`);
  const values = seriesValues(column);
  if (values.length === 0) throw new RowFilterError(`split column "${columnName}" has no values`);
  if (values.length > MAX_SPLIT) {
    throw new RowFilterError(`split column "${columnName}" has ${values.length} values; a line layer draws at most ${MAX_SPLIT} (filter some out)`);
  }
  const series = values.map(({ value, index }) => ({ value, index, data: applyRowFilter(data, [{ column: columnName, values: [value] }]) }));

  // Shared ranges, from the whole table.
  const ranges = new Map<string, [number, number]>();
  for (const c of data.table.columns) if (c.type === 'number' || c.type === 'time') ranges.set(c.name, [c.min, c.max]);
  // One cadence step per time column: the finest positive step among the series.
  const steps = new Map<string, number>();
  for (const s of series) {
    for (const [name, cad] of Object.entries(s.data.cadences)) {
      if (!(cad.step > 0)) continue;
      steps.set(name, Math.min(steps.get(name) ?? Infinity, cad.step));
    }
  }
  return series.map(({ value, index, data: view }) => {
    const columns = view.table.columns.map((c) => {
      const r = ranges.get(c.name);
      return r && (c.type === 'number' || c.type === 'time') ? { ...c, min: r[0], max: r[1] } : c;
    });
    const cadences: Record<string, Cadence> = {};
    for (const [name, cad] of Object.entries(view.cadences)) cadences[name] = { ...cad, step: steps.get(name) ?? cad.step };
    return { value, index, data: { ...view, table: { ...view.table, columns }, cadences } };
  });
}
