/**
 * Horizon chart data (HorizonLayerSchema). Pure, tested, and allocation-free once its buffers
 * exist (the output re-combines the columns while a data playhead sweeps).
 *
 * Each row has a t (its index within its own series, so interleaved series each fill their whole
 * strip; or in time mode its time in cadence steps from the time column's first value, as lines
 * and instancers count it), a value and a series. A row stands for one step of t, [t, t + 1):
 * one row, or one cadence step in time mode. Rows [first, last] are combined into `columns`
 * columns across [tLo, tHi) per series: column c holds every row whose step overlaps its slice,
 * so a few rows fill wide blocks and many rows share a column. Missing values and rows with a
 * missing t or series are left out; a column no row reaches (a gap in time) is NaN, never filled.
 */

import type { HorizonLayer } from '../shared/layer-schema.ts';
import { MAX_HORIZON_SERIES } from '../shared/layer-schema.ts';
import type { Column, Table } from './columns.ts';
import type { Cadence } from './gaps.ts';
import { LayerDataError } from './instance-data.ts';
import { seriesValues } from './line-split.ts';

const DAY_MS = 86_400_000;

export type HorizonFn = HorizonLayer['fn'];

export interface HorizonSource {
  rowCount: number;
  /** t per row, NaN where missing. */
  t: Float64Array;
  /** Value per row, NaN where missing. */
  v: Float32Array;
  /** Series per row (index into `names`), -1 where missing. */
  series: Int32Array;
  names: string[];
}

/** Fields whose change needs the source rebuilt. */
export function horizonStructureKey(layer: HorizonLayer): string {
  return JSON.stringify([layer.datasetId, layer.xMode, layer.xMode === 'time' ? layer.timeColumn : null, layer.valueColumn, layer.seriesColumn]);
}

function find(table: Table, name: string, what: string): Column {
  const c = table.columns.find((col) => col.name === name);
  if (!c) throw new LayerDataError(`${what}: column "${name}" not found`);
  return c;
}

/** The rows' t, values and series, or null until a value column is chosen (and a time column in time mode). */
export function prepareHorizon(layer: HorizonLayer, table: Table, cadences: Record<string, Cadence>): HorizonSource | null {
  if (layer.valueColumn === null) return null;
  if (layer.xMode === 'time' && layer.timeColumn === null) return null;
  const n = table.rowCount;
  const value = find(table, layer.valueColumn, 'value');
  if (value.type !== 'number') throw new LayerDataError(`value: column "${value.name}" holds ${value.type === 'time' ? 'times' : 'text'}; a horizon chart needs numbers`);
  const v = Float32Array.from(value.values);

  const series = new Int32Array(n);
  let names = [''];
  if (layer.seriesColumn !== null) {
    const sc = find(table, layer.seriesColumn, 'series');
    const present = seriesValues(sc);
    if (present.length > MAX_HORIZON_SERIES) {
      throw new LayerDataError(`series column "${sc.name}" has ${present.length} values; a horizon chart draws at most ${MAX_HORIZON_SERIES} (filter some out)`);
    }
    names = present.map((p) => p.value);
    const strip = new Map(names.map((name, i) => [name, i]));
    for (let i = 0; i < n; i++) {
      const text = sc.type === 'category' ? (sc.codes[i]! >= 0 ? sc.dictionary[sc.codes[i]!]! : null) : sc.type === 'text' ? sc.values[i]! : null;
      series[i] = text === null ? -1 : (strip.get(text) ?? -1);
    }
  }

  const t = new Float64Array(n);
  if (layer.xMode === 'time') {
    const tc = find(table, layer.timeColumn!, 'time column');
    if (tc.type !== 'time') throw new LayerDataError(`"${tc.name}" is not a time column`);
    const step = cadences[tc.name]?.step;
    const unit = step !== undefined && step > 0 && Number.isFinite(step) ? step : DAY_MS;
    for (let i = 0; i < n; i++) t[i] = (tc.values[i]! - tc.min) / unit;
  } else {
    // Each series counts its own rows.
    const next = new Float64Array(names.length);
    for (let i = 0; i < n; i++) {
      const s = series[i]!;
      t[i] = s < 0 ? NaN : next[s]!++;
    }
  }
  return { rowCount: n, t, v, series, names };
}

/** [smallest t, largest t + 1) of rows [first, last]: the steps they cover (NaN when none has a t). */
export function horizonSpan(src: HorizonSource, first: number, last: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let r = Math.max(0, first); r <= Math.min(src.rowCount - 1, last); r++) {
    const t = src.t[r]!;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return Number.isFinite(lo) ? [lo, hi + 1] : [NaN, NaN];
}

/**
 * Combine rows [first, last] into `out` (columns × series, series-major: out[s * columns + c])
 * over [tLo, tHi] by `fn`. `count` is scratch of the same size.
 */
export function combineHorizon(
  src: HorizonSource,
  first: number,
  last: number,
  tLo: number,
  tHi: number,
  columns: number,
  fn: HorizonFn,
  out: Float32Array,
  count: Float32Array,
): void {
  const cells = columns * src.names.length;
  out.fill(fn === 'min' ? Infinity : fn === 'max' ? -Infinity : 0, 0, cells);
  count.fill(0, 0, cells);
  const span = tHi - tLo;
  const scale = span > 0 ? columns / span : 0;
  for (let r = Math.max(0, first); r <= Math.min(src.rowCount - 1, last); r++) {
    const s = src.series[r]!;
    const v = src.v[r]!;
    const t = src.t[r]!;
    if (s < 0 || Number.isNaN(v) || !(t >= tLo && t < tHi)) continue;
    // The columns the row's step [t, t + 1) overlaps.
    const c0 = span > 0 ? Math.min(columns - 1, Math.floor((t - tLo) * scale)) : 0;
    const c1 = span > 0 ? Math.max(c0, Math.min(columns - 1, Math.ceil((t + 1 - tLo) * scale) - 1)) : 0;
    for (let c = c0; c <= c1; c++) {
      const i = s * columns + c;
      count[i]! += 1;
      if (fn === 'sum' || fn === 'mean') out[i]! += v;
      else if (fn === 'min') out[i] = Math.min(out[i]!, v);
      else if (fn === 'max') out[i] = Math.max(out[i]!, v);
      else out[i] = v; // last
    }
  }
  for (let i = 0; i < cells; i++) {
    const k = count[i]!;
    out[i] = k === 0 ? NaN : fn === 'mean' ? out[i]! / k : out[i]!;
  }
}

/**
 * Largest distance from `baseline` among the first n combined columns (NaN gaps skipped): the
 * auto range, taken from what is drawn (a column's mean, not the single largest row). 1 when
 * there is none.
 */
export function horizonExtent(columns: Float32Array, n: number, baseline: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = columns[i]!;
    if (Number.isNaN(v)) continue;
    const d = Math.abs(v - baseline);
    if (d > m) m = d;
  }
  return m > 0 ? m : 1;
}

/**
 * The shade (0 = empty, 1..bands) at height y (0..1 up the strip) for value v: the bands of the
 * value's distance from the baseline (as a share of the domain) stacked on top of each other.
 * The CPU twin of the fragment shader.
 */
export function horizonLevel(v: number, baseline: number, domain: number, bands: number, y: number): number {
  const n = Math.min(1, Math.abs(v - baseline) / domain) * bands;
  const full = Math.floor(n);
  return Math.min(bands, full + (n - full > y ? 1 : 0));
}
