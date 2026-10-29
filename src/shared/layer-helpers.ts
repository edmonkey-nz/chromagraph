import { FRAME_H, firstVaryingNumber, fitLineLayer, isDailyStep, timeColumns, type DatasetSummary } from './layer-defaults.ts';
import {
  NUMERIC_CHANNELS,
  type Cloner,
  type HeatmapLayer,
  type InstancerLayer,
  type LayerConfig,
  type LayerType,
  type LineLayer,
} from './layer-schema.ts';
import { repairLevels, repairSplit } from './level-helpers.ts';
import type { Path } from './patch.ts';

/**
 * Pure helpers for the control window's Layers panel: titles, the instance budget readout,
 * the Ridgeline presets (instancer and line), minimal field diffs (for Fit to output and
 * presets) and the field changes when a layer switches dataset. No DOM, so they are tested
 * in Node.
 */

/** A field change inside one layer (path relative to the layer). */
export interface LayerChange {
  path: Path;
  value: unknown;
}

export const LAYER_TYPE_TITLES: Record<LayerType, string> = {
  instancer: 'instancer',
  line: 'line',
  heatmap: 'heat map',
  text: 'text',
  multiples: 'small multiples',
  hierarchy: 'hierarchy',
  surface: '3D surface',
  reflector: 'reflection plane',
  qr: 'QR code',
  density: 'density map',
};

/** Instances the output can draw at 60 fps across all layers on the target laptop. */
export const FRAME_BUDGET = 200_000;

/** Rows drawn for a row range over `rowCount` rows (as the output's instancer counts them). */
export function visibleRowCount(rowCount: number, rows: readonly [number, number]): number {
  const n = Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
  const lo = Math.min(rows[0], rows[1]);
  const hi = Math.max(rows[0], rows[1]);
  if (n === 0 || !Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  const first = Math.max(0, Math.floor(lo * n));
  const last = Math.min(n - 1, Math.ceil(hi * n) - 1);
  return Math.max(0, last - first + 1);
}

/** Segments a line draws for `rowCount` rows: one between each pair of consecutive visible rows. */
export function lineSegmentCount(rowCount: number, rows: readonly [number, number]): number {
  return Math.max(0, visibleRowCount(rowCount, rows) - 1);
}

/**
 * Instances a layer draws (an upper bound, before missing values are dropped): visible rows x
 * clone count for an instancer, segments x clone count for a line (each segment is one
 * instanced quad), one mark per visible row for small multiples, 0 for the other types.
 */
export function instanceCount(layer: LayerConfig, rowCount: number): number {
  switch (layer.type) {
    case 'instancer':
      return visibleRowCount(rowCount, layer.rows) * Math.max(1, layer.cloner.count);
    case 'line':
      return lineSegmentCount(rowCount, layer.rows) * Math.max(1, layer.cloner.count);
    case 'multiples':
      return visibleRowCount(rowCount, layer.rows);
    default:
      return 0;
  }
}

const num = (v: number) => v.toLocaleString('en-NZ');

/**
 * Two-line readout for a cloner: "instances: 42,748 rows × 3 = 128,244" (`unit` is "segments"
 * for a line) and either the total against the budget or a warning when it is over.
 */
export function budgetReadout(rows: number, count: number, allLayers: number, unit = 'rows'): string {
  const line1 = `instances: ${num(rows)} ${unit} × ${num(count)} = ${num(rows * count)}`;
  const own = rows * count;
  if (own > FRAME_BUDGET) return `${line1}\nWARNING: over the ${num(FRAME_BUDGET)} frame budget`;
  if (allLayers > FRAME_BUDGET) return `${line1}\nWARNING: all layers ${num(allLayers)}, over the ${num(FRAME_BUDGET)} budget`;
  return `${line1}\nall layers ${num(allLayers)} of ${num(FRAME_BUDGET)}`;
}

/** Clone count of the Ridgeline preset. */
export const RIDGELINE_COUNT = 40;

/**
 * Cloner fields for the "Ridgeline" preset on an instancer: 40 clones stacked 12 px apart,
 * fading by 0.98 each, where each clone takes its values from one "year" further on
 * (dataStep = 365 rows when the layer's time column is daily, otherwise about 1/40 of the
 * visible rows), so the clones become a waterfall of successive years.
 */
export function ridgelineCloner(layer: InstancerLayer, summary: DatasetSummary | null): Pick<Cloner, 'count' | 'position' | 'dataStep' | 'fade'> {
  return { count: RIDGELINE_COUNT, position: [0, 12, 0], dataStep: ridgelineDataStep(layer, summary), fade: 0.98 };
}

/** Rows a clone steps for a ridgeline: a year of a daily time column, else 1/40 of the visible rows. */
function ridgelineDataStep(layer: { timeColumn: string | null; rows: [number, number] }, summary: DatasetSummary | null): number {
  const step = layer.timeColumn !== null ? summary?.cadences[layer.timeColumn]?.step : undefined;
  if (step !== undefined && isDailyStep(step)) return 365;
  const rows = summary ? visibleRowCount(summary.rowCount, layer.rows) : 0;
  return Math.max(1, Math.round(rows / RIDGELINE_COUNT));
}

export const EDGE_PRESETS = ['outline', 'neon'] as const;
export type EdgePreset = (typeof EDGE_PRESETS)[number];

/**
 * Edge style presets for a box instancer (returns the new layer; diff it):
 *   outline  dark, solid boxes with 2 px red edges (no glow)
 *   neon     glassy boxes (faces at 0.12) with 3 px cyan edges at full edge glow, and the
 *            layer's glow switched on (threshold 0.3) so the edges bloom
 * The primitive becomes a box; mapped colours are left alone (the face colour is the
 * layer colour only when colour is unmapped).
 */
export function edgePreset(layer: InstancerLayer, preset: EdgePreset): InstancerLayer {
  const out = structuredClone(layer);
  out.primitive = 'box';
  if (preset === 'outline') {
    out.edges = { enabled: true, colour: '#ff2a2a', width: 2, faceOpacity: 1, glow: 0 };
    out.colour = '#141416';
  } else {
    out.edges = { enabled: true, colour: '#29e6ff', width: 3, faceOpacity: 0.12, glow: 1 };
    out.colour = '#1a6cff';
    out.effects.glow = { enabled: true, strength: 1.2, radius: 0.5, threshold: 0.3 };
  }
  return out;
}

/** px between the baselines of a line ridgeline's clones. */
export const LINE_RIDGE_SPACING = 14;
/** y range px of a line ridgeline: values rise from each clone's baseline. */
export const LINE_RIDGE_HEIGHT = 160;

/**
 * The "Ridgeline" preset on a line layer (Joy Division style): 40 clones 14 px apart, each
 * showing the data one "year" of rows further on (dataStep = 365 for a daily time column,
 * otherwise about 1/40 of the visible rows), no fade, filled below in `background` so nearer
 * clones hide the ones behind; a 2 px white line over the first year's rows
 * (rows [0, dataStep / rowCount]). The layout is refitted so that year runs across the frame,
 * with values rising 0..160 px from each baseline and the whole stack centred vertically.
 * An unmapped y takes the first varying numeric column. Returns the new layer (diff it).
 */
export function ridgelineLine(layer: LineLayer, summary: DatasetSummary | null, background: string): LineLayer {
  const out = structuredClone(layer);
  const dataStep = ridgelineDataStep(layer, summary);
  out.cloner = {
    ...out.cloner,
    count: RIDGELINE_COUNT,
    position: [0, LINE_RIDGE_SPACING, 0],
    orbit: [0, 0, 0],
    dataStep,
    fade: 1,
  };
  out.fill = { mode: 'below', colour: background, opacity: 1 };
  out.width = 2;
  out.colour = '#ffffff';
  const rowCount = summary && Number.isFinite(summary.rowCount) ? summary.rowCount : 0;
  out.rows = rowCount > 0 ? [0, Math.min(1, dataStep / rowCount)] : [0, 1];
  out.y.range = [0, LINE_RIDGE_HEIGHT];
  if (out.y.column === null && summary) out.y.column = firstVaryingNumber(summary)?.name ?? null;
  if (!summary) return out;
  const fitted = fitLineLayer(out, summary);
  const stack = (RIDGELINE_COUNT - 1) * LINE_RIDGE_SPACING + LINE_RIDGE_HEIGHT;
  fitted.origin = [fitted.origin[0], (FRAME_H - stack) / 2, fitted.origin[2]];
  return fitted;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Minimal `set` changes that turn `before` into `after`: objects are compared field by field,
 * arrays (tuples) and plain values as a whole. Fields only in `before` are ignored (layer
 * shapes are fixed by the schema).
 */
export function diffChanges(before: unknown, after: unknown, path: Path = []): LayerChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: LayerChange[] = [];
    for (const [k, v] of Object.entries(after)) out.push(...diffChanges(before[k], v, [...path, k]));
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, value: after }];
}

/**
 * Field changes for switching a layer to dataset `datasetId` (null for none): column
 * references the new dataset doesn't have are dropped (with their manual domains), and a
 * time-dependent mode falls back when no time column is left. Grouping columns are re-pointed
 * rather than dropped: a small multiples split moves to a suitable column (or another split,
 * see repairSplit) and hierarchy levels are re-pointed or dropped, keeping at least one
 * (repairLevels). `summary` is the new
 * dataset's summary, or null if it hasn't parsed yet (then only the id changes).
 */
export function datasetSwitchChanges(layer: LayerConfig, datasetId: string | null, summary: DatasetSummary | null): LayerChange[] {
  const changes: LayerChange[] = [{ path: ['datasetId'], value: datasetId }];
  // A filter names the old dataset's columns and values.
  if (layer.filter.length > 0 && datasetId !== layer.datasetId) changes.push({ path: ['filter'], value: [] });
  if (!summary || layer.type === 'text' || layer.type === 'reflector' || layer.type === 'qr') return changes;
  const times = timeColumns(summary);
  const timeNames = times.map((c) => c.name);
  const names = new Set(summary.columns.filter((c) => !c.empty).map((c) => c.name));
  const dropColumn = (base: Path, column: string | null) => {
    if (column !== null && !names.has(column)) changes.push({ path: [...base, 'column'], value: null }, { path: [...base, 'domain'], value: null });
  };

  /** Drop a top-level value column the dataset doesn't have, with its manual domain. */
  const dropValue = (valueColumn: string | null) => {
    if (valueColumn !== null && !names.has(valueColumn)) changes.push({ path: ['valueColumn'], value: null }, { path: ['domain'], value: null });
  };

  switch (layer.type) {
    case 'heatmap':
    case 'surface': {
      // Cell layouts: keep a time column (preferring a daily one) for the calendar, else a grid.
      const cells: Pick<HeatmapLayer, 'timeColumn' | 'layout'> = layer;
      let timeColumn = cells.timeColumn;
      if (timeColumn === null || !timeNames.includes(timeColumn)) {
        const daily = times.find((c) => isDailyStep(summary.cadences[c.name]?.step ?? NaN));
        timeColumn = (daily ?? times[0])?.name ?? null;
      }
      if (timeColumn !== cells.timeColumn) changes.push({ path: ['timeColumn'], value: timeColumn });
      if (cells.layout === 'calendar' && timeColumn === null) changes.push({ path: ['layout'], value: 'grid' });
      dropValue(layer.valueColumn);
      return changes;
    }
    case 'multiples': {
      const split = repairSplit(layer.splitBy, layer.splitColumn, summary);
      if (split.splitBy !== layer.splitBy) changes.push({ path: ['splitBy'], value: split.splitBy });
      if (split.splitColumn !== layer.splitColumn) changes.push({ path: ['splitColumn'], value: split.splitColumn });
      dropValue(layer.valueColumn);
      return changes;
    }
    case 'hierarchy': {
      const levels = repairLevels(layer.levels, summary);
      if (JSON.stringify(levels) !== JSON.stringify(layer.levels)) changes.push({ path: ['levels'], value: levels });
      dropValue(layer.valueColumn);
      return changes;
    }
    case 'density': {
      const usable = new Set(summary.columns.filter((c) => !c.empty && (c.type === 'number' || c.type === 'time')).map((c) => c.name));
      if (layer.xColumn !== null && !usable.has(layer.xColumn)) changes.push({ path: ['xColumn'], value: null }, { path: ['xDomain'], value: null });
      if (layer.yColumn !== null && !usable.has(layer.yColumn)) changes.push({ path: ['yColumn'], value: null }, { path: ['yDomain'], value: null });
      if (layer.zColumn !== null && !usable.has(layer.zColumn)) changes.push({ path: ['zColumn'], value: null }, { path: ['zDomain'], value: null });
      return changes;
    }
    case 'instancer':
    case 'line':
      break;
  }

  // Instancer and line share the x mode / time column pair.
  let timeColumn = layer.timeColumn;
  if (timeColumn !== null && !timeNames.includes(timeColumn)) timeColumn = timeNames[0] ?? null;
  if (timeColumn === null && layer.xMode === 'time') timeColumn = timeNames[0] ?? null;
  if (timeColumn !== layer.timeColumn) changes.push({ path: ['timeColumn'], value: timeColumn });
  if (layer.xMode === 'time' && timeColumn === null) changes.push({ path: ['xMode'], value: 'index' });

  if (layer.type === 'instancer') {
    for (const ch of [...NUMERIC_CHANNELS, 'colour'] as const) dropColumn(['channels', ch], layer.channels[ch].column);
  } else {
    dropColumn(['y'], layer.y.column);
    dropColumn(['z'], layer.z.column);
    dropColumn(['colourMap'], layer.colourMap.column);
  }
  return changes;
}
