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
import { MISSING } from './instance-data.ts';
import { P_ROW, P_T, P_Y, POINT_STRIDE, type LineData } from './line-data.ts';
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

/**
 * Stack split series (LineSplitSchema.stack) in order, bottom first. Each series' points become
 * the top of its slice and its band (lo, hi per row) the slice itself, so the line's band fill
 * draws the area. A point stacks only where every series it needs has a point at the same t
 * (within half a step): series below it for 'stack', all of them for 'stream' (centred on the
 * baseline: the pile starts at minus half the total). Elsewhere it is left out and the line breaks
 * there; a missing value is never taken as zero. Returns new LineData; the inputs are untouched.
 * The y auto domain of every result is the whole pile's.
 */
export function stackSeries(series: LineData[], mode: 'stack' | 'stream'): LineData[] {
  const TOL = 0.5;
  /** Value of series k at t, or NaN when it has no point there (points ascend in t). */
  const valueAt = (d: LineData, t: number): number => {
    let lo = 0;
    let hi = d.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const tm = d.points[mid * POINT_STRIDE + P_T]!;
      if (Math.abs(tm - t) < TOL) return d.points[mid * POINT_STRIDE + P_Y]!;
      if (tm < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return NaN;
  };
  let dLo = Infinity;
  let dHi = -Infinity;
  const out = series.map((d, s) => {
    const lo = new Float32Array(d.rowCount).fill(MISSING);
    const hi = new Float32Array(d.rowCount).fill(MISSING);
    const values = new Float32Array(d.rowCount).fill(MISSING);
    const kept: number[] = [];
    for (let p = 0; p < d.count; p++) {
      const o = p * POINT_STRIDE;
      const t = d.points[o + P_T]!;
      const own = d.points[o + P_Y]!;
      let below = 0;
      let ok = true;
      for (let k = 0; k < s && ok; k++) {
        const v = valueAt(series[k]!, t);
        if (Number.isNaN(v)) ok = false;
        else below += v;
      }
      let offset = 0;
      if (ok && mode === 'stream') {
        let total = below + own;
        for (let k = s + 1; k < series.length && ok; k++) {
          const v = valueAt(series[k]!, t);
          if (Number.isNaN(v)) ok = false;
          else total += v;
        }
        offset = -total / 2;
      }
      if (!ok) continue;
      const base = offset + below;
      const top = base + own;
      const row = d.points[o + P_ROW]!;
      lo[row] = base;
      hi[row] = top;
      values[row] = top;
      kept.push(p);
      dLo = Math.min(dLo, base, top);
      dHi = Math.max(dHi, base, top);
    }
    const points = new Float32Array(kept.length * POINT_STRIDE);
    kept.forEach((p, i) => {
      points.set(d.points.subarray(p * POINT_STRIDE, (p + 1) * POINT_STRIDE), i * POINT_STRIDE);
      points[i * POINT_STRIDE + P_Y] = hi[d.points[p * POINT_STRIDE + P_ROW]!]!;
    });
    return { ...d, count: kept.length, points, y: d.y ? { ...d.y, values } : null, band: { lo, hi } };
  });
  if (Number.isFinite(dLo)) for (const d of out) if (d.y) d.y = { ...d.y, autoDomain: [dLo, dHi] };
  return out;
}
