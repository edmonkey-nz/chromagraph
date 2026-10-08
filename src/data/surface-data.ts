/**
 * Grid and height maths for 3D surface layers. Pure (no GPU), so it is unit-tested.
 *
 * The cells come from the heat map's cell builder (prepareHeatmap / fillCells in
 * heatmap-data.ts): calendar (years x 366 days, several rows a day combined per `aggregate`)
 * or grid (one cell per row, gridColumns per line). The output uploads them as an R32F data
 * texture and places one vertex per cell centre, displaced along +z in the vertex shader.
 *
 * A cell with no value (EMPTY_CELL), a calendar cell that is not a date (VOID_CELL), a cell
 * past the end of the data and, in grid layout, a cell outside `rows` is a hole: every
 * triangle touching it is dropped. Holes are never interpolated over.
 */
import { blankHeatmapLayer, type ScaleType, type SurfaceLayer } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Table } from './columns.ts';
import { heatmapGrid, prepareHeatmap, type HeatmapSource } from './heatmap-data.ts';
import { MISSING_TEST, normalise } from './instance-data.ts';

/**
 * The surface schema has no quantise step count (a contract gap), so quantise uses the same
 * default the other layer types start with.
 */
/** Default quantise step count (the layer's `steps` overrides it). */
export const SURFACE_QUANTISE_STEPS = 5;

/** Fields whose change needs a new cell source (everything else is a uniform update or a refill). */
export function surfaceStructureKey(layer: SurfaceLayer, timeZone: string): string {
  const calendar = layer.layout === 'calendar';
  return JSON.stringify([layer.datasetId, layer.layout, calendar ? layer.timeColumn : null, calendar ? timeZone : '', layer.valueColumn]);
}

/**
 * Validate the layer and index its rows into cells, through the heat map's builder (the
 * fields it reads are the same on both schemas). Null while not configured yet; throws
 * LayerDataError for a missing or wrongly typed column.
 */
export function prepareSurface(layer: SurfaceLayer, table: Table, calendars: Record<string, CalendarFields>): HeatmapSource | null {
  const asHeatmap = {
    ...blankHeatmapLayer(layer.id, layer.name, layer.datasetId),
    layout: layer.layout,
    timeColumn: layer.timeColumn,
    valueColumn: layer.valueColumn,
    rows: layer.rows,
    gridColumns: layer.gridColumns,
    aggregate: layer.aggregate,
  };
  return prepareHeatmap(asHeatmap, table, calendars);
}

/** Columns and rows of vertices (one per cell). */
export function surfaceGrid(src: HeatmapSource, gridColumns: number): [number, number] {
  return heatmapGrid(src, gridColumns);
}

/**
 * Whether cell (col, row) is a hole; mirrors the vertex shader's valueAt(). `rows` is the
 * visible row range [first, last], applied to grid layout only (the calendar refills).
 */
export function isHole(
  cells: Float32Array,
  src: HeatmapSource,
  cols: number,
  rowsDown: number,
  col: number,
  row: number,
  rows: readonly [number, number],
): boolean {
  if (col < 0 || row < 0 || col >= cols || row >= rowsDown) return true;
  const i = row * cols + col;
  if (i >= src.cellCount) return true;
  if (src.layout === 'grid' && (i < rows[0] || i > rows[1])) return true;
  return !(cells[i]! > MISSING_TEST);
}

/** Height (px along +z) of a cell value; mirrors the shader (clamped scale maths). */
export function surfaceHeight(
  v: number,
  domain: readonly [number, number],
  scale: ScaleType,
  height: readonly [number, number],
  steps: number = SURFACE_QUANTISE_STEPS,
): number {
  const n = normalise(v, [domain[0], domain[1]], scale, steps, true);
  return height[0] + (height[1] - height[0]) * n;
}

/**
 * Position (px) of the vertex at cell (col, row): the cell's centre, with the top-left cell
 * at `origin` and rows going downward, as the heat map draws them.
 */
export function vertexXY(origin: readonly [number, number, number], cell: readonly [number, number], col: number, row: number): [number, number] {
  return [origin[0] + (col + 0.5) * cell[0], origin[1] - (row + 0.5) * cell[1]];
}

/** Quads drawn (one per cell whose right and lower neighbours exist), before holes. */
export function quadCount(cols: number, rowsDown: number): number {
  return Math.max(0, cols - 1) * Math.max(0, rowsDown - 1);
}
