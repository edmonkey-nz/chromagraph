/**
 * Density map data (DensityLayerSchema): rows counted into a grid of bins by their x and y, then
 * smoothed with a separable gaussian. Pure, allocation-free once its buffers exist (the output
 * re-bins while a data playhead sweeps), and tested.
 *
 * Bin (0, 0) is bottom-left: column i covers x from domain[0] + i / binsX of the span, row j
 * likewise in y (y up, as the output's pixel space). A value exactly at the top of a domain falls
 * in the last bin. Rows with a missing x or y, or outside either domain, are not counted; nothing
 * is filled in.
 *
 * With a z column (dots mode) the bins are 3D: index (k * binsY + j) * binsX + i, k from the
 * front (z domain[0]). Rows with a missing z then drop out too.
 */

import type { DensityLayer } from '../shared/layer-schema.ts';
import type { Column, Table } from './columns.ts';
import { LayerDataError } from './instance-data.ts';

const DAY_MS = 86_400_000;

export interface DensitySource {
  rowCount: number;
  /** x and y per row (time columns in days from the column min), NaN where missing. */
  x: Float32Array;
  y: Float32Array;
  /** z per row in dots mode with a z column, else null. */
  z: Float32Array | null;
  /** The columns' own ranges, in the same units: the auto domains. */
  xAuto: [number, number];
  yAuto: [number, number];
  zAuto: [number, number];
}

/** Fields whose change needs the source rebuilt (everything else re-bins or is a uniform). */
export function densityStructureKey(layer: DensityLayer): string {
  return JSON.stringify([layer.datasetId, layer.xColumn, layer.yColumn, densityZColumn(layer)]);
}

/** The z column a layer counts by: only in dots mode. */
export function densityZColumn(layer: DensityLayer): string | null {
  return layer.mode === 'dots' ? layer.zColumn : null;
}

function values(table: Table, name: string, what: string): { v: Float32Array; auto: [number, number] } {
  const c: Column | undefined = table.columns.find((col) => col.name === name);
  if (!c) throw new LayerDataError(`${what}: column "${name}" not found`);
  const n = c.length;
  const v = new Float32Array(n);
  if (c.type === 'number') {
    v.set(c.values);
    return { v, auto: [c.min, c.max] };
  }
  if (c.type === 'time') {
    for (let i = 0; i < n; i++) v[i] = (c.values[i]! - c.min) / DAY_MS;
    return { v, auto: [0, (c.max - c.min) / DAY_MS] };
  }
  throw new LayerDataError(`${what}: column "${name}" holds ${c.type === 'category' ? 'categories' : 'text'}; a density map needs numbers or times`);
}

/** The rows' x and y, or null until both columns are chosen. */
export function prepareDensity(layer: DensityLayer, table: Table): DensitySource | null {
  if (layer.xColumn === null || layer.yColumn === null) return null;
  const x = values(table, layer.xColumn, 'x');
  const y = values(table, layer.yColumn, 'y');
  const zName = densityZColumn(layer);
  const z = zName === null ? null : values(table, zName, 'z');
  return { rowCount: table.rowCount, x: x.v, y: y.v, z: z?.v ?? null, xAuto: x.auto, yAuto: y.auto, zAuto: z?.auto ?? [0, 1] };
}

/** The domain in use: the layer's, else the column's (a flat or empty range becomes [v - 0.5, v + 0.5]). */
export function densityDomain(domain: readonly [number, number] | null, auto: readonly [number, number]): [number, number] {
  const [a, b] = domain ?? auto;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [0, 1];
  if (a === b) return [a - 0.5, a + 0.5];
  return [a, b];
}

/**
 * Count rows [first, last] into `out` (binsX × binsY × binsZ, row-major from the bottom row and
 * the front layer), cleared first. Without a z column, binsZ is 1. Returns how many rows were
 * counted.
 */
export function binDensity(
  src: DensitySource,
  first: number,
  last: number,
  xDomain: readonly [number, number],
  yDomain: readonly [number, number],
  binsX: number,
  binsY: number,
  out: Float32Array,
  zDomain: readonly [number, number] = [0, 1],
  binsZ = 1,
): number {
  const depth = src.z ? binsZ : 1;
  out.fill(0, 0, binsX * binsY * depth);
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const [z0, z1] = zDomain;
  const sx = binsX / (x1 - x0);
  const sy = binsY / (y1 - y0);
  const sz = depth / (z1 - z0);
  const zs = src.z;
  const lo = Math.max(0, first);
  const hi = Math.min(src.rowCount - 1, last);
  let counted = 0;
  for (let r = lo; r <= hi; r++) {
    const fx = (src.x[r]! - x0) * sx;
    const fy = (src.y[r]! - y0) * sy;
    // NaN fails both comparisons, so missing values drop out here too.
    if (!(fx >= 0 && fx <= binsX && fy >= 0 && fy <= binsY)) continue;
    let k = 0;
    if (zs) {
      const fz = (zs[r]! - z0) * sz;
      if (!(fz >= 0 && fz <= depth)) continue;
      k = Math.min(depth - 1, Math.floor(fz));
    }
    const i = Math.min(binsX - 1, Math.floor(fx));
    const j = Math.min(binsY - 1, Math.floor(fy));
    out[(k * binsY + j) * binsX + i]! += 1;
    counted++;
  }
  return counted;
}

/** Normalised gaussian weights for sigma (in bins), radius ceil(3 sigma). */
export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(0, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  if (sigma <= 0) {
    k[0] = 1;
    return k;
  }
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = w;
    sum += w;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/**
 * Separable gaussian blur of `grid` in place, using `tmp` (same size). Edges don't wrap: weight
 * falling outside the grid is lost, as density beyond the map would be. Total count is kept away
 * from the edges.
 */
export function blurDensity(grid: Float32Array, binsX: number, binsY: number, kernel: Float32Array, tmp: Float32Array, binsZ = 1): void {
  const r = (kernel.length - 1) >> 1;
  if (r === 0) return;
  const plane = binsX * binsY;
  for (let k = 0; k < binsZ; k++) {
    const o = k * plane;
    blurPlane(grid.subarray(o, o + plane), binsX, binsY, kernel, tmp.subarray(o, o + plane), r);
  }
  if (binsZ < 2) return;
  // Depth pass, plane by plane (contiguous): output plane k sums whole input planes s.
  tmp.set(grid.subarray(0, plane * binsZ));
  grid.fill(0, 0, plane * binsZ);
  for (let k = 0; k < binsZ; k++) {
    const out = k * plane;
    const a = Math.max(0, k - r);
    const b = Math.min(binsZ - 1, k + r);
    for (let s = a; s <= b; s++) {
      const w = kernel[s - k + r]!;
      const src = s * plane;
      for (let i = 0; i < plane; i++) grid[out + i]! += tmp[src + i]! * w;
    }
  }
}

function blurPlane(grid: Float32Array, binsX: number, binsY: number, kernel: Float32Array, tmp: Float32Array, r: number): void {
  for (let j = 0; j < binsY; j++) {
    const row = j * binsX;
    for (let i = 0; i < binsX; i++) {
      let acc = 0;
      const a = Math.max(0, i - r);
      const b = Math.min(binsX - 1, i + r);
      for (let s = a; s <= b; s++) acc += grid[row + s]! * kernel[s - i + r]!;
      tmp[row + i] = acc;
    }
  }
  // Vertical pass row by row (contiguous reads): output row j sums whole input rows s.
  grid.fill(0, 0, binsX * binsY);
  for (let j = 0; j < binsY; j++) {
    const out = j * binsX;
    const a = Math.max(0, j - r);
    const b = Math.min(binsY - 1, j + r);
    for (let s = a; s <= b; s++) {
      const w = kernel[s - j + r]!;
      const src = s * binsX;
      for (let i = 0; i < binsX; i++) grid[out + i]! += tmp[src + i]! * w;
    }
  }
}

/** Largest value in the first n entries (0 when empty). */
export function gridMax(grid: Float32Array, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) if (grid[i]! > m) m = grid[i]!;
  return m;
}
