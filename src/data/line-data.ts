/**
 * Point arrays and the gap rule for line layers. Pure (no GPU), so it is unit-tested; the
 * output uploads `points` once as an interleaved instanced buffer and draws one screen-space
 * quad per segment, doing the placement and scale maths in the vertex shader. Changing rows,
 * origin, step, domains, ranges, width, colours or the gap settings is a uniform update.
 *
 * Only drawable rows become points: a row whose t or any mapped value is missing is left
 * out (never drawn as zero). Segments join consecutive points, and a segment that skips
 * rows therefore spans missing data; `segmentBroken` decides whether it is drawn.
 */
import type { LineLayer, ScaleType } from '../shared/layer-schema.ts';
import type { Column, Table } from './columns.ts';
import type { Cadence } from './gaps.ts';
import { LayerDataError, MISSING, normalise, resolveDomain, type ChannelData } from './instance-data.ts';

export const MAX_LINE_POINTS = 1_000_000;
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
  return { count: 0, points: new Float32Array(0), rowCount, timeMode, y: null, z: null, colour: null };
}

/**
 * Build the drawable points for a line layer. A layer that is not configured yet (time
 * mode without a time column) yields no points rather than an error; a column that does
 * not exist or has the wrong type is a LayerDataError.
 */
export function buildLineData(layer: LineLayer, table: Table, cadences: Record<string, Cadence>): LineData {
  const n = table.rowCount;
  if (n > MAX_LINE_POINTS) throw new LayerDataError(`${n} rows is more than the ${MAX_LINE_POINTS} point limit`);
  const timeMode = layer.xMode === 'time';
  if (timeMode && !layer.timeColumn) return emptyLine(n, timeMode);

  // t per row (MISSING where undefined), as in buildInstanceData.
  const t = new Float32Array(n);
  if (timeMode) {
    const tc = column(table, layer.timeColumn!, 'time column');
    if (tc.type !== 'time') throw new LayerDataError(`"${tc.name}" is not a time column`);
    const step = cadences[tc.name]?.step;
    const unit = step !== undefined && step > 0 && Number.isFinite(step) ? step : DAY_MS;
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
  return { count, points, rowCount: n, timeMode, y, z, colour };
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
  return data.timeMode && p[b + P_T]! - p[a + P_T]! > gapFactor;
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

function mapValue(v: number, domain: [number, number], m: { scale: ScaleType; steps: number; clamp: boolean; range: [number, number] }): number {
  const n = normalise(v, domain, m.scale, m.steps, m.clamp);
  return m.range[0] + (m.range[1] - m.range[0]) * n;
}
