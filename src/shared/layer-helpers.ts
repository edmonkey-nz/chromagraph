import { isDailyStep, timeColumns, type DatasetSummary } from './layer-defaults.ts';
import { NUMERIC_CHANNELS, type Cloner, type InstancerLayer, type LayerConfig, type LayerType } from './layer-schema.ts';
import type { Path } from './patch.ts';

/**
 * Pure helpers for the control window's Layers panel: titles, the instance budget readout,
 * minimal field diffs (for Fit to output) and the field changes when a layer switches
 * dataset. No DOM, so they are tested in Node.
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

/** Instances a layer draws: visible rows x clone count for an instancer, 0 for other types. */
export function instanceCount(layer: LayerConfig, rowCount: number): number {
  if (layer.type !== 'instancer') return 0;
  return visibleRowCount(rowCount, layer.rows) * Math.max(1, layer.cloner.count);
}

const num = (v: number) => v.toLocaleString('en-NZ');

/**
 * Two-line readout for an instancer's cloner: "instances: 42,748 rows × 3 = 128,244" and
 * either the total against the budget or a warning when it is over.
 */
export function budgetReadout(rows: number, count: number, allLayers: number): string {
  const line1 = `instances: ${num(rows)} rows × ${num(count)} = ${num(rows * count)}`;
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
  const step = layer.timeColumn !== null ? summary?.cadences[layer.timeColumn]?.step : undefined;
  const daily = step !== undefined && isDailyStep(step);
  const rows = summary ? visibleRowCount(summary.rowCount, layer.rows) : 0;
  const dataStep = daily ? 365 : Math.max(1, Math.round(rows / RIDGELINE_COUNT));
  return { count: RIDGELINE_COUNT, position: [0, 12, 0], dataStep, fade: 0.98 };
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
 * time-dependent mode falls back when no time column is left. `summary` is the new
 * dataset's summary, or null if it hasn't parsed yet (then only the id changes).
 */
export function datasetSwitchChanges(layer: LayerConfig, datasetId: string | null, summary: DatasetSummary | null): LayerChange[] {
  const changes: LayerChange[] = [{ path: ['datasetId'], value: datasetId }];
  if (!summary || layer.type === 'text') return changes;
  const times = timeColumns(summary);
  const timeNames = times.map((c) => c.name);
  const names = new Set(summary.columns.filter((c) => !c.empty).map((c) => c.name));
  const dropColumn = (base: Path, column: string | null) => {
    if (column !== null && !names.has(column)) changes.push({ path: [...base, 'column'], value: null }, { path: [...base, 'domain'], value: null });
  };

  if (layer.type === 'heatmap') {
    let timeColumn = layer.timeColumn;
    if (timeColumn === null || !timeNames.includes(timeColumn)) {
      const daily = times.find((c) => isDailyStep(summary.cadences[c.name]?.step ?? NaN));
      timeColumn = (daily ?? times[0])?.name ?? null;
    }
    if (timeColumn !== layer.timeColumn) changes.push({ path: ['timeColumn'], value: timeColumn });
    if (layer.layout === 'calendar' && timeColumn === null) changes.push({ path: ['layout'], value: 'grid' });
    if (layer.valueColumn !== null && !names.has(layer.valueColumn)) {
      changes.push({ path: ['valueColumn'], value: null }, { path: ['domain'], value: null });
    }
    return changes;
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
