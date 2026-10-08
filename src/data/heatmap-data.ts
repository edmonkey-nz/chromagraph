/**
 * Cell values for heat map layers. Pure (no GPU), so it is unit-tested; the output packs the
 * cells into one R32F data texture and a single quad's fragment shader looks each cell up,
 * applies the scale (the instancer's `norm` maths) and the ramp.
 *
 *   calendar  one cell per (year, day of year): rows are years from the first year (top),
 *             columns are the 366 days, in the dataset's timezone. Several rows on one day
 *             combine per `aggregate`.
 *   grid      one cell per data row, in row order; gridColumns per line is a uniform.
 *
 * Empty cells (no contributing value) are EMPTY_CELL and are never filled in. Calendar cells
 * that are not dates at all (day 366 of a common year) are VOID_CELL and always transparent.
 */
import type { AGGREGATES, HeatmapLayer, ScaleType } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Table } from './columns.ts';
import { LayerDataError, MISSING } from './instance-data.ts';

export type Aggregate = (typeof AGGREGATES)[number];

/** A cell with no data. Same encoding as the instancer's MISSING (below MISSING_TEST). */
export const EMPTY_CELL = MISSING;
/** A calendar cell that is not a real date. Anything below VOID_TEST is void. */
export const VOID_CELL = Math.fround(-3e30);
export const VOID_TEST = -2e30;
export const CALENDAR_DAYS = 366;
/** Data texture width; cells are packed row-major into rows of this many texels. */
export const DATA_TEX_WIDTH = 2048;
export const MAX_CELLS = 2_000_000;

export interface HeatmapSource {
  layout: 'calendar' | 'grid';
  rowCount: number;
  /** Value per data row, NaN where missing. */
  values: Float32Array;
  /** Calendar: cell index per data row (-1 where the time is missing). Grid: null (cell = row). */
  cellOfRow: Int32Array | null;
  /** Number of cells: years x 366 (calendar) or the row count (grid). */
  cellCount: number;
  /** Calendar: years spanned and the first year. Grid: 0. */
  years: number;
  firstYear: number;
}

export interface CellStats {
  /** Min and max of the non-empty cells (NaN when there are none). */
  min: number;
  max: number;
  /** Smallest positive cell value (NaN when there is none), for auto log domains. */
  minPositive: number;
  /** Number of non-empty cells. */
  filled: number;
}

export function emptyStats(): CellStats {
  return { min: NaN, max: NaN, minPositive: NaN, filled: 0 };
}

/** Fields whose change needs a new source (columns, layout, timezone). */
export function heatmapStructureKey(layer: HeatmapLayer, timeZone: string): string {
  const calendar = layer.layout === 'calendar';
  return JSON.stringify([layer.datasetId, layer.layout, calendar ? layer.timeColumn : null, calendar ? timeZone : '', layer.valueColumn]);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Validate the layer against the table and index the rows into cells. Returns null when the
 * layer is not configured yet (no value column, or calendar without a time column); throws
 * LayerDataError for a column that does not exist or has the wrong type.
 */
export function prepareHeatmap(layer: HeatmapLayer, table: Table, calendars: Record<string, CalendarFields>): HeatmapSource | null {
  if (!layer.valueColumn) return null;
  if (layer.layout === 'calendar' && !layer.timeColumn) return null;
  const vc = table.columns.find((c) => c.name === layer.valueColumn);
  if (!vc) throw new LayerDataError(`value column "${layer.valueColumn}" not found`);
  if (vc.type !== 'number') throw new LayerDataError(`value column "${vc.name}" is a ${vc.type} column; a heat map needs numbers`);
  const n = table.rowCount;
  const values = vc.values;

  if (layer.layout === 'grid') {
    if (n > MAX_CELLS) throw new LayerDataError(`${n} rows is more than the ${MAX_CELLS} cell limit`);
    return { layout: 'grid', rowCount: n, values, cellOfRow: null, cellCount: n, years: 0, firstYear: 0 };
  }

  const tc = table.columns.find((c) => c.name === layer.timeColumn);
  if (!tc) throw new LayerDataError(`time column "${layer.timeColumn}" not found`);
  if (tc.type !== 'time') throw new LayerDataError(`"${tc.name}" is not a time column`);
  const cal = calendars[tc.name];
  if (!cal) throw new LayerDataError(`calendar fields for "${tc.name}" are not available yet`);
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = cal.year[i]!;
    if (y < first) first = y;
    if (y > last) last = y;
  }
  const years = Number.isFinite(first) ? last - first + 1 : 0;
  if (years * CALENDAR_DAYS > MAX_CELLS) throw new LayerDataError(`${years} years is more than the calendar can show`);
  const cellOfRow = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const y = cal.year[i]!;
    const d = cal.dayOfYear[i]!;
    cellOfRow[i] = Number.isNaN(y) || Number.isNaN(d) ? -1 : (y - first) * CALENDAR_DAYS + d;
  }
  return { layout: 'calendar', rowCount: n, values, cellOfRow, cellCount: years * CALENDAR_DAYS, years, firstYear: Number.isFinite(first) ? first : 0 };
}

/** Texels needed for `cellCount` cells packed DATA_TEX_WIDTH wide: [width, height]. */
export function textureShape(cellCount: number): [number, number] {
  return [DATA_TEX_WIDTH, Math.max(1, Math.ceil(cellCount / DATA_TEX_WIDTH))];
}

/** Scratch buffers for fillCells, allocated once per source. */
export interface CellScratch {
  sum: Float64Array;
  count: Uint32Array;
}

export function cellScratch(src: HeatmapSource): CellScratch {
  const size = src.layout === 'calendar' ? src.cellCount : 0;
  return { sum: new Float64Array(size), count: new Uint32Array(size) };
}

/**
 * Fill `out` (at least cellCount long) with one value per cell from the data rows
 * first..last (inclusive). Missing values do not contribute; a cell without any value stays
 * EMPTY_CELL. No allocation, so it can run whenever `rows` changes.
 *
 * Grid: cell i is row i, whatever the range (the range is applied by the shader instead).
 * Statistics go into `stats` (pass a reused object to avoid allocating).
 */
export function fillCells(
  src: HeatmapSource,
  aggregate: Aggregate,
  first: number,
  last: number,
  out: Float32Array,
  scratch: CellScratch,
  stats: CellStats = emptyStats(),
): CellStats {
  const values = src.values;
  if (src.layout === 'grid') {
    for (let i = 0; i < src.cellCount; i++) {
      const v = values[i]!;
      out[i] = Number.isNaN(v) ? EMPTY_CELL : v;
    }
    accumulateStats(out, src.cellCount, stats);
    return stats;
  }

  const cellOfRow = src.cellOfRow!;
  const { sum, count } = scratch;
  sum.fill(0);
  count.fill(0);
  const lo = Math.max(0, first);
  const hi = Math.min(src.rowCount - 1, last);
  for (let i = lo; i <= hi; i++) {
    const c = cellOfRow[i]!;
    const v = values[i]!;
    if (c < 0 || Number.isNaN(v)) continue;
    const k = count[c]!;
    switch (aggregate) {
      case 'mean':
      case 'sum':
        sum[c] = sum[c]! + v;
        break;
      case 'min':
        sum[c] = k === 0 ? v : Math.min(sum[c]!, v);
        break;
      case 'max':
        sum[c] = k === 0 ? v : Math.max(sum[c]!, v);
        break;
      case 'last':
        sum[c] = v;
        break;
    }
    count[c] = k + 1;
  }
  for (let year = 0; year < src.years; year++) {
    const leap = isLeap(src.firstYear + year);
    const base = year * CALENDAR_DAYS;
    for (let d = 0; d < CALENDAR_DAYS; d++) {
      const c = base + d;
      const k = count[c]!;
      if (k > 0) out[c] = aggregate === 'mean' ? sum[c]! / k : sum[c]!;
      else out[c] = !leap && d === CALENDAR_DAYS - 1 ? VOID_CELL : EMPTY_CELL;
    }
  }
  accumulateStats(out, src.cellCount, stats);
  return stats;
}

function accumulateStats(cells: Float32Array, n: number, stats: CellStats): void {
  let min = Infinity;
  let max = -Infinity;
  let minPositive = Infinity;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const v = cells[i]!;
    if (v === EMPTY_CELL || v === VOID_CELL) continue;
    filled++;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0 && v < minPositive) minPositive = v;
  }
  stats.filled = filled;
  stats.min = filled ? min : NaN;
  stats.max = filled ? max : NaN;
  stats.minPositive = Number.isFinite(minPositive) ? minPositive : NaN;
}

/**
 * The domain the shader scales with: the explicit one, or "auto" from the cell values (for
 * log, from the smallest positive value), mirroring resolveDomain in instance-data.ts.
 */
export function heatmapDomain(scale: ScaleType, domain: readonly [number, number] | null, stats: CellStats): [number, number] {
  if (domain) return [domain[0], domain[1]];
  let lo = stats.min;
  let hi = stats.max;
  if (scale === 'log' && !(lo > 0)) {
    lo = Number.isFinite(stats.minPositive) ? stats.minPositive : 1;
    if (!(hi > lo)) hi = lo * 10;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}

/** Columns and rows of cells the quad shows. */
export function heatmapGrid(src: HeatmapSource, gridColumns: number): [number, number] {
  if (src.layout === 'calendar') return [CALENDAR_DAYS, src.years];
  const cols = Math.max(1, Math.floor(gridColumns));
  return [cols, Math.max(1, Math.ceil(src.cellCount / cols))];
}
