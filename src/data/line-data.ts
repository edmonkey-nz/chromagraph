/**
 * Point arrays and the gap rule for line layers. Pure (no GPU), so it is unit-tested; the
 * output uploads `points` once as an interleaved instanced buffer and draws one screen-space
 * quad per segment, doing the placement and scale maths in the vertex shader. Changing rows,
 * origin, step, domains, ranges, width, colours or the gap settings is a uniform update.
 *
 * Only drawable rows become points: a row whose t or any mapped value is missing is left
 * out (never drawn as zero). Segments join consecutive points, and a segment that skips
 * rows therefore spans missing data; `segmentBroken` decides whether it is drawn.
 *
 * Cloner (ridgelines): clone k of the line keeps the original's points, t and gap rule, but
 * takes its mapped values from data row `row + k * dataStep`. Where that row is outside the
 * data, or one of its mapped values is missing, clone k breaks there (`clonePointDrawable`).
 * With the fill on, each drawn segment also gets an area down to the clone's baseline.
 *
 * Band (fill 'band', aggregated lines with y mapped): each bucket also keeps the lowest and
 * highest y of its rows (`band`), and the fill spans them instead of reaching the baseline.
 * The y auto domain then covers the band, so it is never clipped.
 */
import type { LineLayer, ScaleType } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Column, Table } from './columns.ts';
import type { Cadence } from './gaps.ts';
import { LayerDataError, MISSING, normalise, resolveDomain, type ChannelData } from './instance-data.ts';

export const MAX_LINE_POINTS = 1_000_000;
/**
 * Ceiling on line instances per draw (segments x pieces x clones, a piece being a line
 * segment or its fill), so a big clone count cannot hang the GPU: clones beyond it are
 * dropped from the far end.
 */
export const MAX_LINE_DRAWN = 4_000_000;
const DAY_MS = 86_400_000;

/** Floats per point in `LineData.points`: t, source row, raw y, raw z, raw colour value. */
export const POINT_STRIDE = 5;
export const P_T = 0;
export const P_ROW = 1;
export const P_Y = 2;
export const P_Z = 3;
export const P_COLOUR = 4;

export interface LineData {
  /** Number of drawable points; there are count - 1 candidate segments. */
  count: number;
  /** Interleaved, POINT_STRIDE floats per point, in row order. Unmapped values are 0. */
  points: Float32Array;
  /** Rows in the table (for the `rows` fractions). */
  rowCount: number;
  /** True when t is in cadence steps of a time column (so t deltas measure time gaps). */
  timeMode: boolean;
  /** Mapped channels (column values with MISSING, for domain resolution), or null. */
  y: ChannelData | null;
  z: ChannelData | null;
  colour: ChannelData | null;
  /**
   * t units per nominal step between points: 1 for raw rows, a bucket's length when
   * aggregated (so the gap rule measures gaps in buckets; see segmentBroken).
   */
  gapUnit: number;
  /** Lowest and highest raw y per row (bucket) for a band fill, MISSING where none; else null. */
  band: { lo: Float32Array; hi: Float32Array } | null;
  /**
   * Aggregated: the table rows of bucket b are bucketStarts[b] .. bucketStarts[b + 1] - 1 (one
   * entry more than there are buckets). Null for raw rows (a point's row is a table row).
   */
  bucketStarts: Int32Array | null;
}

/** True when the layer draws a min-max band (needs aggregation and a y column). */
export function wantsBand(layer: LineLayer): boolean {
  return layer.fill.mode === 'band' && layer.aggregate.by !== 'none' && layer.y.column !== null;
}

/** Fields whose change needs new point arrays (everything else is a uniform update). */
export function lineStructureKey(layer: LineLayer): string {
  return JSON.stringify([
    layer.datasetId,
    layer.xMode,
    layer.xMode === 'time' ? layer.timeColumn : null,
    layer.y.column,
    layer.z.column,
    layer.colourMap.column,
    layer.aggregate.by,
    layer.aggregate.by === 'none' ? null : [layer.aggregate.fn, layer.aggregate.by === 'rows' ? layer.aggregate.rows : null, layer.timeColumn],
    wantsBand(layer),
    layer.split.column,
  ]);
}

function column(table: Table, name: string, what: string): Column {
  const c = table.columns.find((col) => col.name === name);
  if (!c) throw new LayerDataError(`${what}: column "${name}" not found`);
  return c;
}

/** Column values as float32 with MISSING for missing values (mirrors the instancer's encoding). */
function channelValues(c: Column, allowCategory: boolean, what: string): ChannelData {
  const n = c.length;
  const out = new Float32Array(n);
  switch (c.type) {
    case 'number':
      for (let i = 0; i < n; i++) {
        const v = c.values[i]!;
        out[i] = Number.isNaN(v) ? MISSING : v;
      }
      return { values: out, autoDomain: [c.min, c.max], categories: 0 };
    case 'time': {
      const min = c.min;
      for (let i = 0; i < n; i++) {
        const v = c.values[i]!;
        out[i] = Number.isNaN(v) ? MISSING : (v - min) / DAY_MS;
      }
      return { values: out, autoDomain: [0, (c.max - min) / DAY_MS], categories: 0 };
    }
    case 'category':
      if (!allowCategory) throw new LayerDataError(`${what}: category column "${c.name}" can only be mapped to colour`);
      for (let i = 0; i < n; i++) {
        const code = c.codes[i]!;
        out[i] = code < 0 ? MISSING : code;
      }
      return { values: out, autoDomain: [0, Math.max(0, c.dictionary.length - 1)], categories: c.dictionary.length };
    case 'text':
      throw new LayerDataError(`${what}: column "${c.name}" is text and cannot be mapped`);
  }
}

function emptyLine(rowCount: number, timeMode: boolean): LineData {
  return { count: 0, points: new Float32Array(0), rowCount, timeMode, y: null, z: null, colour: null, gapUnit: 1, band: null, bucketStarts: null };
}

/**
 * Build the drawable points for a line layer. A layer that is not configured yet (time
 * mode without a time column) yields no points rather than an error; a column that does
 * not exist or has the wrong type is a LayerDataError.
 */
export function buildLineData(
  layer: LineLayer,
  table: Table,
  cadences: Record<string, Cadence>,
  calendars: Record<string, CalendarFields> = {},
): LineData {
  const n = table.rowCount;
  if (n > MAX_LINE_POINTS) throw new LayerDataError(`${n} rows is more than the ${MAX_LINE_POINTS} point limit`);
  const timeMode = layer.xMode === 'time';
  if (timeMode && !layer.timeColumn) return emptyLine(n, timeMode);

  // t per row (MISSING where undefined), as in buildInstanceData.
  const t = new Float32Array(n);
  let unit = DAY_MS;
  if (timeMode) {
    const tc = column(table, layer.timeColumn!, 'time column');
    if (tc.type !== 'time') throw new LayerDataError(`"${tc.name}" is not a time column`);
    const step = cadences[tc.name]?.step;
    unit = step !== undefined && step > 0 && Number.isFinite(step) ? step : DAY_MS;
    for (let i = 0; i < n; i++) {
      const v = tc.values[i]!;
      t[i] = Number.isNaN(v) ? MISSING : (v - tc.min) / unit;
    }
  } else {
    for (let i = 0; i < n; i++) t[i] = i;
  }

  const y = layer.y.column ? channelValues(column(table, layer.y.column, 'y'), false, 'y') : null;
  const z = layer.z.column ? channelValues(column(table, layer.z.column, 'z'), false, 'z') : null;
  const colour = layer.colourMap.column ? channelValues(column(table, layer.colourMap.column, 'colour'), true, 'colour') : null;

  if (layer.aggregate.by !== 'none') {
    const calendar = layer.timeColumn ? (calendars[layer.timeColumn] ?? null) : null;
    return aggregateLine(layer, t, y, z, colour, calendar, timeMode, unit);
  }

  const missing = (i: number): boolean =>
    t[i]! === MISSING || (y !== null && y.values[i]! === MISSING) || (z !== null && z.values[i]! === MISSING) || (colour !== null && colour.values[i]! === MISSING);

  let count = 0;
  for (let i = 0; i < n; i++) if (!missing(i)) count++;
  const points = new Float32Array(count * POINT_STRIDE);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (missing(i)) continue;
    const o = k * POINT_STRIDE;
    points[o + P_T] = t[i]!;
    points[o + P_ROW] = i;
    points[o + P_Y] = y ? y.values[i]! : 0;
    points[o + P_Z] = z ? z.values[i]! : 0;
    points[o + P_COLOUR] = colour ? colour.values[i]! : 0;
    k++;
  }
  return { count, points, rowCount: n, timeMode, y, z, colour, gapUnit: 1, band: null, bucketStarts: null };
}

const NOMINAL_DAYS = { week: 7, month: 365.25 / 12, year: 365.25 } as const;

/** 0-based month of a 0-based day of year. */
export function monthOfDay(year: number, dayOfYear: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const ends = [31, leap ? 60 : 59, leap ? 91 : 90, leap ? 121 : 120, leap ? 152 : 151, leap ? 182 : 181, leap ? 213 : 212, leap ? 244 : 243, leap ? 274 : 273, leap ? 305 : 304, leap ? 335 : 334];
  let m = 0;
  while (m < 11 && dayOfYear >= ends[m]!) m++;
  return m;
}

/**
 * One point per bucket (see LineLayerSchema.aggregate). Buckets follow row order: a new one
 * starts where the bucket key changes. Each becomes a "row" of the result, so the row
 * range, data playhead and cloner count buckets. A bucket with no value for a mapped channel
 * is missing (the line breaks there), never zero.
 */
function aggregateLine(
  layer: LineLayer,
  t: Float32Array,
  y: ChannelData | null,
  z: ChannelData | null,
  colour: ChannelData | null,
  calendar: CalendarFields | null,
  timeMode: boolean,
  unitMs: number,
): LineData {
  const { by, fn } = layer.aggregate;
  const n = t.length;
  const size = Math.max(1, Math.floor(layer.aggregate.rows));
  if (by !== 'rows' && !calendar) throw new LayerDataError(`aggregating by ${by} needs a time column (with its calendar fields loaded)`);
  const keyOf = (i: number): number => {
    if (by === 'rows') return Math.floor(i / size);
    const yr = calendar!.year[i]!;
    if (Number.isNaN(yr)) return NaN;
    const doy = calendar!.dayOfYear[i]!;
    if (by === 'year') return yr;
    if (by === 'month') return yr * 12 + monthOfDay(yr, doy);
    return yr * 53 + Math.floor(doy / 7);
  };

  // Bucket boundaries (first row of each), in row order.
  const starts: number[] = [];
  let previous = NaN;
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    if (Number.isNaN(k)) continue;
    if (k !== previous) starts.push(i);
    previous = k;
  }
  const buckets = starts.length;
  const bt = new Float32Array(buckets).fill(MISSING);
  const reduce = (c: ChannelData | null, f: typeof fn): ChannelData | null => {
    if (!c) return null;
    const out = new Float32Array(buckets).fill(MISSING);
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = 0; b < buckets; b++) {
      const end = b + 1 < buckets ? starts[b + 1]! : n;
      let count = 0;
      let acc = f === 'min' ? Infinity : f === 'max' ? -Infinity : 0;
      for (let i = starts[b]!; i < end; i++) {
        const v = c.values[i]!;
        if (v === MISSING || Number.isNaN(keyOf(i))) continue;
        count++;
        if (f === 'sum' || f === 'mean') acc += v;
        else if (f === 'min') acc = Math.min(acc, v);
        else if (f === 'max') acc = Math.max(acc, v);
        else acc = v; // last
      }
      if (count === 0) continue;
      const v = f === 'mean' ? acc / count : acc;
      out[b] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const domain: [number, number] = Number.isFinite(lo) ? [lo, hi] : c.autoDomain;
    return { values: out, autoDomain: domain, categories: c.categories };
  };
  // Categories have no mean: a colour-by-category line takes each bucket's last value.
  let yb = reduce(y, fn);
  let band: LineData['band'] = null;
  if (wantsBand(layer) && y && yb) {
    const lo = reduce(y, 'min')!;
    const hi = reduce(y, 'max')!;
    band = { lo: lo.values, hi: hi.values };
    // The domain covers the band (an empty band keeps the line's own domain).
    if (Number.isFinite(lo.autoDomain[0]) && Number.isFinite(hi.autoDomain[1])) {
      yb = { ...yb, autoDomain: [Math.min(yb.autoDomain[0], lo.autoDomain[0]), Math.max(yb.autoDomain[1], hi.autoDomain[1])] };
    }
  }
  const zb = reduce(z, fn);
  const cb = reduce(colour, colour && colour.categories > 0 ? 'last' : fn);

  // t of a bucket: the middle of its rows' time (or index) span.
  for (let b = 0; b < buckets; b++) {
    const end = b + 1 < buckets ? starts[b + 1]! : n;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = starts[b]!; i < end; i++) {
      const v = t[i]!;
      if (v === MISSING) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (Number.isFinite(lo)) bt[b] = (lo + hi) / 2;
  }

  const missing = (b: number): boolean =>
    bt[b]! === MISSING || (yb !== null && yb.values[b]! === MISSING) || (zb !== null && zb.values[b]! === MISSING) || (cb !== null && cb.values[b]! === MISSING);
  let count = 0;
  for (let b = 0; b < buckets; b++) if (!missing(b)) count++;
  const points = new Float32Array(count * POINT_STRIDE);
  let k = 0;
  for (let b = 0; b < buckets; b++) {
    if (missing(b)) continue;
    const o = k * POINT_STRIDE;
    points[o + P_T] = bt[b]!;
    points[o + P_ROW] = b;
    points[o + P_Y] = yb ? yb.values[b]! : 0;
    points[o + P_Z] = zb ? zb.values[b]! : 0;
    points[o + P_COLOUR] = cb ? cb.values[b]! : 0;
    k++;
  }
  const gapUnit = by === 'rows' ? size : timeMode ? (NOMINAL_DAYS[by as keyof typeof NOMINAL_DAYS] * DAY_MS) / unitMs : 1;
  const bucketStarts = new Int32Array(buckets + 1);
  bucketStarts.set(starts);
  bucketStarts[buckets] = n;
  return { count, points, rowCount: buckets, timeMode, y: yb, z: zb, colour: cb, gapUnit, band, bucketStarts };
}

/** Visible rows [first, last] (inclusive) for `rows` fractions, as the instancer computes them. */
export function rowRange(rows: readonly [number, number], n: number): [number, number] {
  const first = Math.max(0, Math.floor(Math.min(rows[0], rows[1]) * n));
  const last = Math.min(n - 1, Math.ceil(Math.max(rows[0], rows[1]) * n) - 1);
  return [first, last];
}

/**
 * The gap rule, mirrored in the line vertex shader. Segment i joins point i to point i + 1.
 * With breakOnGaps it is not drawn when it skips rows (a missing value lies between) or,
 * in time mode, when its time span exceeds gapFactor cadence steps. Without, it always joins.
 */
export function segmentBroken(data: LineData, i: number, breakOnGaps: boolean, gapFactor: number): boolean {
  if (!breakOnGaps) return false;
  const a = i * POINT_STRIDE;
  const b = a + POINT_STRIDE;
  const p = data.points;
  if (p[b + P_ROW]! - p[a + P_ROW]! > 1.5) return true;
  return data.timeMode && p[b + P_T]! - p[a + P_T]! > gapFactor * data.gapUnit;
}

/** Whether segment i is drawn for the given rows range and gap settings. */
export function segmentVisible(data: LineData, i: number, first: number, last: number, breakOnGaps: boolean, gapFactor: number): boolean {
  if (i < 0 || i >= data.count - 1) return false;
  const p = data.points;
  const a = i * POINT_STRIDE;
  if (p[a + P_ROW]! < first || p[a + POINT_STRIDE + P_ROW]! > last) return false;
  return !segmentBroken(data, i, breakOnGaps, gapFactor);
}

/** Index of the first point whose source row is >= `row` (binary search; count if none). */
export function firstPointAtOrAfter(data: LineData, row: number): number {
  let lo = 0;
  let hi = data.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data.points[mid * POINT_STRIDE + P_ROW]! < row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** t subtracted from every point for followRange (t of the first point in the range), else 0. */
export function lineTStart(data: LineData, followRange: boolean, first: number): number {
  if (!followRange) return 0;
  const k = firstPointAtOrAfter(data, first);
  return k < data.count ? data.points[k * POINT_STRIDE + P_T]! : 0;
}

/**
 * CPU twin of the vertex shader's placement: px position of every point (x, y, z per
 * point). Used by tests and diagnostics, not per frame.
 */
export function linePositions(data: LineData, layer: LineLayer): Float32Array {
  const out = new Float32Array(data.count * 3);
  const [first] = rowRange(layer.rows, data.rowCount);
  const t0 = lineTStart(data, layer.followRange, first);
  const yDomain = data.y ? resolveDomain(layer.y, data.y) : null;
  const zDomain = data.z ? resolveDomain(layer.z, data.z) : null;
  for (let k = 0; k < data.count; k++) {
    const o = k * POINT_STRIDE;
    const t = data.points[o + P_T]! - t0;
    let x = layer.origin[0] + t * layer.step[0];
    let y = layer.origin[1] + t * layer.step[1];
    let z = layer.origin[2] + t * layer.step[2];
    if (yDomain) y += mapValue(data.points[o + P_Y]!, yDomain, layer.y);
    if (zDomain) z += mapValue(data.points[o + P_Z]!, zDomain, layer.z);
    out[k * 3] = x;
    out[k * 3 + 1] = y;
    out[k * 3 + 2] = z;
  }
  return out;
}

/**
 * px position of the last drawable point in the visible rows (clone 0), written to `out`
 * (x, y, z); false when no point is visible. Allocation-free, so split line labels can follow
 * a modulated layer every frame. CPU twin of the vertex shader's placement, as linePositions.
 */
export function lastVisiblePoint(data: LineData, layer: LineLayer, out: number[]): boolean {
  if (data.count === 0) return false;
  const [first, last] = rowRange(layer.rows, data.rowCount);
  const k = firstPointAtOrAfter(data, last + 1) - 1;
  if (k < 0 || data.points[k * POINT_STRIDE + P_ROW]! < first) return false;
  const o = k * POINT_STRIDE;
  const t = data.points[o + P_T]! - lineTStart(data, layer.followRange, first);
  out[0] = layer.origin[0] + t * layer.step[0];
  out[1] = layer.origin[1] + t * layer.step[1];
  out[2] = layer.origin[2] + t * layer.step[2];
  if (data.y) out[1] += mapValue(data.points[o + P_Y]!, domainOf(layer.y, data.y), layer.y);
  if (data.z) out[2] += mapValue(data.points[o + P_Z]!, domainOf(layer.z, data.z), layer.z);
  return true;
}

/** resolveDomain without allocating, except for the log scale's search. */
function domainOf(m: LineLayer['y'], c: ChannelData): [number, number] {
  if (m.domain) return m.domain;
  if (m.scale === 'log' || !Number.isFinite(c.autoDomain[0]) || !Number.isFinite(c.autoDomain[1])) return resolveDomain(m, c);
  return c.autoDomain;
}

function mapValue(v: number, domain: [number, number], m: { scale: ScaleType; steps: number; clamp: boolean; range: [number, number] }): number {
  const n = normalise(v, domain, m.scale, m.steps, m.clamp);
  return m.range[0] + (m.range[1] - m.range[0]) * n;
}

/** Segments drawn for the visible rows [first, last]: [first segment, count], both ends in range. */
export function segmentRange(data: LineData, first: number, last: number): [number, number] {
  if (data.count < 2 || last < first) return [0, 0];
  const start = firstPointAtOrAfter(data, first);
  const endPoint = firstPointAtOrAfter(data, last + 1) - 1; // last point with row <= last
  return [start, Math.max(0, endPoint - start)];
}

/** Clones actually drawn: `count`, capped so instances (perClone each) stay within MAX_LINE_DRAWN. */
export function lineCloneCount(count: number, perClone: number): number {
  if (perClone <= 0) return Math.max(1, count);
  return Math.max(1, Math.min(count, Math.floor(MAX_LINE_DRAWN / perClone)));
}

/** Data row clone k reads for source row `row`, or -1 when it steps outside the data. */
export function cloneDataRow(row: number, k: number, dataStep: number, rowCount: number): number {
  const r = row + k * dataStep;
  return r >= 0 && r < rowCount ? r : -1;
}

/** Whether clone k has values at point p: its data row exists and no mapped value there is missing. */
export function clonePointDrawable(data: LineData, p: number, k: number, dataStep: number): boolean {
  const r = cloneDataRow(data.points[p * POINT_STRIDE + P_ROW]!, k, dataStep, data.rowCount);
  if (r < 0) return false;
  return !(
    (data.y !== null && data.y.values[r]! === MISSING) ||
    (data.z !== null && data.z.values[r]! === MISSING) ||
    (data.colour !== null && data.colour.values[r]! === MISSING)
  );
}

/**
 * Whether clone k draws segment i (and, with the fill on, its area): the original's rows
 * range and gap rule, and both ends drawable for that clone. Mirrored in the vertex shader.
 */
export function cloneSegmentVisible(
  data: LineData,
  i: number,
  k: number,
  dataStep: number,
  first: number,
  last: number,
  breakOnGaps: boolean,
  gapFactor: number,
): boolean {
  if (!segmentVisible(data, i, first, last, breakOnGaps, gapFactor)) return false;
  return clonePointDrawable(data, i, k, dataStep) && clonePointDrawable(data, i + 1, k, dataStep);
}

/**
 * CPU twin of the vertex shader's placement for clone k (offset by k x cloner.position;
 * orbit is left out): x, y, z per point, NaN where the clone has no value. Tests and
 * diagnostics only.
 */
export function cloneLinePositions(data: LineData, layer: LineLayer, k: number): Float32Array {
  const out = new Float32Array(data.count * 3);
  const [first] = rowRange(layer.rows, data.rowCount);
  const t0 = lineTStart(data, layer.followRange, first);
  const yDomain = data.y ? resolveDomain(layer.y, data.y) : null;
  const zDomain = data.z ? resolveDomain(layer.z, data.z) : null;
  const off = layer.cloner.position;
  for (let p = 0; p < data.count; p++) {
    const o = p * POINT_STRIDE;
    const r = cloneDataRow(data.points[o + P_ROW]!, k, layer.cloner.dataStep, data.rowCount);
    if (!clonePointDrawable(data, p, k, layer.cloner.dataStep)) {
      out.fill(NaN, p * 3, p * 3 + 3);
      continue;
    }
    const t = data.points[o + P_T]! - t0;
    let y = layer.origin[1] + t * layer.step[1] + k * off[1];
    let z = layer.origin[2] + t * layer.step[2] + k * off[2];
    if (yDomain) y += mapValue(data.y!.values[r]!, yDomain, layer.y);
    if (zDomain) z += mapValue(data.z!.values[r]!, zDomain, layer.z);
    out[p * 3] = layer.origin[0] + t * layer.step[0] + k * off[0];
    out[p * 3 + 1] = y;
    out[p * 3 + 2] = z;
  }
  return out;
}

/** y of clone k's fill baseline: the line's origin.y plus the clone's y offset. */
export function fillBaseline(layer: LineLayer, k: number): number {
  return layer.origin[1] + k * layer.cloner.position[1];
}
