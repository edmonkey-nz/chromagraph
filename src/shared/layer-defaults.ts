/**
 * Sensible starting layouts for every layer type. Pure: no DOM or Node APIs, so both windows
 * and the tests can use it.
 *
 * `defaultLayerFor` picks an instancer view for a dataset (calendar for daily time series,
 * bars for other time series or plain row order), and `fitLayer` sizes the arrangement so the
 * visible rows fill the 1920x1080 output frame inside a 60 px margin. The line, heat map and
 * text layers have their own `default*LayerFor` / `fit*Layer` pairs; `defaultLayerOfType`
 * and `fitAnyLayer` dispatch on the type.
 */

import type { ColumnType, Table } from '../data/columns.ts';
import {
  blankHeatmapLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankTextLayer,
  unmapped,
  type HeatmapLayer,
  type InstancerLayer,
  type LayerConfig,
  type LayerType,
  type LineLayer,
  type TextLayer,
  blankMultiplesLayer,
  blankHierarchyLayer,
  blankSurfaceLayer,
} from './layer-schema.ts';
import type { Dataset } from './project-schema.ts';

export const FRAME_W = 1920;
export const FRAME_H = 1080;
export const MARGIN = 60;
const USABLE_W = FRAME_W - 2 * MARGIN;
const USABLE_H = FRAME_H - 2 * MARGIN;

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.2425;
/** Baseline of linear bars, px from the bottom of the frame (leaves room for labels later). */
const LINEAR_BASE_Y = 140;
const LINEAR_MAX_HEIGHT = 800;
const RADIAL_RADIUS = 400;
const SPIRAL_START = 80;
const SPIRAL_END = USABLE_H / 2;
const SPIRAL_TURNS = 12;

export interface SummaryColumn {
  name: string;
  type: ColumnType;
  min: number;
  max: number;
  empty: boolean;
}

/** What layer defaults and the control GUI need to know about a parsed dataset. */
export interface DatasetSummary {
  rowCount: number;
  columns: SummaryColumn[];
  /** Cadence step (ms) of each non-empty time column, by column name. */
  cadences: Record<string, { step: number }>;
}

export function summarise(table: Table, cadences: Record<string, { step: number }>): DatasetSummary {
  const steps: Record<string, { step: number }> = {};
  for (const [name, c] of Object.entries(cadences)) steps[name] = { step: c.step };
  return {
    rowCount: table.rowCount,
    columns: table.columns.map((c) => ({ name: c.name, type: c.type, min: c.min, max: c.max, empty: c.empty })),
    cadences: steps,
  };
}

// ---- helpers ------------------------------------------------------------------------

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function atLeast(min: number, v: number): number {
  return Number.isFinite(v) ? Math.max(min, v) : min;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Non-empty time columns with a usable min/max. */
export function timeColumns(summary: DatasetSummary): SummaryColumn[] {
  return summary.columns.filter((c) => c.type === 'time' && !c.empty && Number.isFinite(c.min) && Number.isFinite(c.max));
}

/** First numeric column that actually varies, or undefined. */
export function firstVaryingNumber(summary: DatasetSummary): SummaryColumn | undefined {
  return summary.columns.find(
    (c) => c.type === 'number' && !c.empty && Number.isFinite(c.min) && Number.isFinite(c.max) && c.max > c.min,
  );
}

function cadenceStep(summary: DatasetSummary, column: string): number {
  const step = summary.cadences[column]?.step;
  return step !== undefined && Number.isFinite(step) && step > 0 ? step : NaN;
}

export function isDailyStep(step: number): boolean {
  return Number.isFinite(step) && Math.abs(step - DAY_MS) <= 0.1 * DAY_MS;
}

/** The fields that decide what "t" means for a layer (instancer and line share them). */
type TLayer = Pick<InstancerLayer, 'xMode' | 'timeColumn'>;

function layerTimeColumn(layer: { timeColumn: string | null }, summary: DatasetSummary): SummaryColumn | undefined {
  if (layer.timeColumn === null) return undefined;
  return timeColumns(summary).find((c) => c.name === layer.timeColumn);
}

/** Calendar year of an epoch-ms instant in a timezone; UTC when the zone is unusable. */
function yearIn(ms: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-NZ', { timeZone, year: 'numeric' }).formatToParts(ms);
    const y = Number(parts.find((p) => p.type === 'year')?.value);
    if (Number.isFinite(y)) return y;
  } catch {
    // fall through to UTC
  }
  return new Date(ms).getUTCFullYear();
}

/**
 * Arrangement extent of the whole dataset in units of t: the last row's index in `index`
 * mode, or (max - min) / cadence step in `time` mode. Never negative or non-finite.
 */
export function tSpanOf(layer: TLayer, summary: DatasetSummary): number {
  const byIndex = Math.max(0, finite(summary.rowCount, 0) - 1);
  if (layer.xMode !== 'time') return byIndex;
  const col = layerTimeColumn(layer, summary);
  if (!col) return byIndex;
  const step = cadenceStep(summary, col.name);
  const span = (col.max - col.min) / step;
  return Number.isFinite(span) && span >= 0 ? span : byIndex;
}

/** Visible row fractions, ordered and clamped to 0..1. */
function visibleFractions(layer: { rows: [number, number] }): [number, number] {
  const a = clamp(finite(layer.rows[0], 0), 0, 1);
  const b = clamp(finite(layer.rows[1], 1), 0, 1);
  return a <= b ? [a, b] : [b, a];
}

/**
 * Calendar rows (years) covered by the visible fraction [s, e] of a time column, and how many
 * years the first visible one is after the column's first year (0 when following the range).
 */
function visibleYears(
  col: SummaryColumn | undefined,
  s: number,
  e: number,
  timeZone: string,
  follow: boolean,
): { years: number; yearOffset: number } {
  if (!col) return { years: 1, yearOffset: 0 };
  const range = col.max - col.min;
  const firstYear = yearIn(col.min, timeZone);
  const startYear = yearIn(col.min + range * s, timeZone);
  const endYear = yearIn(col.min + range * e, timeZone);
  return {
    years: Math.max(1, finite(endYear - startYear + 1, 1)),
    yearOffset: follow ? 0 : Math.max(0, finite(startYear - firstYear, 0)),
  };
}

/** Grid columns and cell size so `n` cells fill the usable frame with roughly square cells. */
function gridFit(n: number): { cols: number; w: number; h: number } {
  const count = Math.max(1, n);
  const cols = clamp(Math.round(Math.sqrt((count * USABLE_W) / USABLE_H)), 1, count);
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, w: atLeast(1, USABLE_W / cols), h: atLeast(1, USABLE_H / rows) };
}

// ---- fitting ------------------------------------------------------------------------

/**
 * Copy of `layer` with its layout (origin, step, cell, size, radius, angleStep, radiusStep,
 * gridColumns, and for linear bars the height range) chosen so the visible rows fill the
 * output frame inside the margin, for the layer's current arrangement and x mode.
 */
export function fitLayer(layer: InstancerLayer, summary: DatasetSummary, timeZone: string): InstancerLayer {
  const out: InstancerLayer = copyLayer(layer);
  const tSpan = tSpanOf(layer, summary);
  const [s, e] = visibleFractions(layer);
  // At least one unit of t, so a single row (or an empty range) never divides by zero.
  const span = Math.max(1, tSpan * (e - s));
  const tStart = layer.followRange ? 0 : tSpan * s;

  switch (layer.arrangement) {
    case 'linear': {
      const sx = USABLE_W / span;
      const barW = atLeast(2, sx * 0.8);
      out.origin = [finite(MARGIN - tStart * sx, MARGIN), LINEAR_BASE_Y, 0];
      out.step = [finite(sx, 1), 0, 0];
      out.size = [barW, layer.primitive === 'bar' ? 100 : barW, barW];
      const h = layer.channels.height.range;
      const low = Number.isFinite(h[0]) && h[0] >= 0 && h[0] < LINEAR_MAX_HEIGHT ? h[0] : 2;
      out.channels.height.range = [low, LINEAR_MAX_HEIGHT];
      break;
    }
    case 'grid': {
      const { cols, w, h } = gridFit(Math.floor(span) + 1);
      const firstRow = Math.floor(tStart / cols);
      out.gridColumns = cols;
      out.cell = [w, h];
      out.origin = [MARGIN + w / 2, finite(FRAME_H - MARGIN - h / 2 + firstRow * h, FRAME_H - MARGIN - h / 2), 0];
      out.size = [w, h, Math.min(w, h)];
      break;
    }
    case 'calendar': {
      const { years, yearOffset } = visibleYears(layerTimeColumn(layer, summary), s, e, timeZone, layer.followRange);
      const w = atLeast(1, USABLE_W / 366);
      const h = atLeast(1, USABLE_H / years);
      out.cell = [w, h];
      out.origin = [MARGIN, finite(FRAME_H - MARGIN - h / 2 + yearOffset * h, FRAME_H - MARGIN - h / 2), 0];
      out.size = [w, h, h];
      break;
    }
    case 'radial': {
      const angle = 360 / span;
      const arc = (2 * Math.PI * RADIAL_RADIUS) / span;
      const w = clamp(atLeast(2, arc * 0.8), 2, 40);
      out.origin = [FRAME_W / 2, FRAME_H / 2, 0];
      out.radius = RADIAL_RADIUS;
      out.angleStep = finite(angle, 1);
      out.size = [w, w, w];
      break;
    }
    case 'spiral': {
      const col = layer.xMode === 'time' ? layerTimeColumn(layer, summary) : undefined;
      const daily = col !== undefined && isDailyStep(cadenceStep(summary, col.name));
      const angle = daily ? 360 / DAYS_PER_YEAR : (SPIRAL_TURNS * 360) / span;
      const radiusStep = (SPIRAL_END - SPIRAL_START) / span;
      const turns = Math.max(1, (span * angle) / 360);
      const ringGap = (SPIRAL_END - SPIRAL_START) / turns;
      const midR = (SPIRAL_START + SPIRAL_END) / 2;
      const arc = (2 * Math.PI * midR * angle) / 360;
      const w = clamp(atLeast(1, Math.min(ringGap, arc) * 0.9), 1, 40);
      out.origin = [FRAME_W / 2, FRAME_H / 2, 0];
      out.radius = finite(SPIRAL_START - tStart * radiusStep, SPIRAL_START);
      out.angleStep = finite(angle, 1);
      out.radiusStep = finite(radiusStep, 0);
      out.size = [w, w, w];
      break;
    }
  }
  return out;
}

/** Deep copy of plain layer data (tuples and channel objects included). */
function copyLayer(layer: InstancerLayer): InstancerLayer {
  return {
    ...layer,
    rows: [layer.rows[0], layer.rows[1]],
    origin: [layer.origin[0], layer.origin[1], layer.origin[2]],
    step: [layer.step[0], layer.step[1], layer.step[2]],
    cell: [layer.cell[0], layer.cell[1]],
    size: [layer.size[0], layer.size[1], layer.size[2]],
    channels: {
      y: copyMapping(layer.channels.y),
      z: copyMapping(layer.channels.z),
      height: copyMapping(layer.channels.height),
      size: copyMapping(layer.channels.size),
      rotation: copyMapping(layer.channels.rotation),
      opacity: copyMapping(layer.channels.opacity),
      colour: { ...layer.channels.colour, domain: layer.channels.colour.domain ? [...layer.channels.colour.domain] : null },
    },
  };
}

function copyMapping<M extends { domain: [number, number] | null; range: [number, number] }>(m: M): M {
  return { ...m, domain: m.domain ? [m.domain[0], m.domain[1]] : null, range: [m.range[0], m.range[1]] };
}

// ---- defaults -----------------------------------------------------------------------

/**
 * A new layer for `dataset`, laid out to fill the frame:
 *   daily time series   calendar of squares (year rows x day-of-year columns), colour by
 *                       the first varying numeric column (sqrt scale, viridis)
 *   other time series   linear bars on a true time axis, height and colour by that column
 *   no time column      linear bars in row order
 */
export function defaultLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): InstancerLayer {
  const layer = blankInstancerLayer(id, name, dataset.id);
  const times = timeColumns(summary);
  const daily = times.find((c) => isDailyStep(cadenceStep(summary, c.name)));
  const value = firstVaryingNumber(summary);

  if (daily) {
    layer.xMode = 'time';
    layer.timeColumn = daily.name;
    layer.arrangement = 'calendar';
    layer.primitive = 'square';
    if (value) {
      layer.channels.colour = {
        ...layer.channels.colour,
        column: value.name,
        // sqrt of a negative is undefined; fall back to linear for signed data.
        scale: value.min >= 0 ? 'sqrt' : 'linear',
        ramp: 'viridis',
        domain: null,
      };
    }
  } else {
    const time = times[0];
    if (time) {
      layer.xMode = 'time';
      layer.timeColumn = time.name;
    } else {
      layer.xMode = 'index';
      layer.timeColumn = null;
    }
    layer.arrangement = 'linear';
    layer.primitive = 'bar';
    if (value) {
      layer.channels.height = { ...layer.channels.height, column: value.name, domain: null };
      layer.channels.colour = { ...layer.channels.colour, column: value.name, ramp: 'viridis', domain: null };
    }
  }
  return fitLayer(layer, summary, dataset.timeZone);
}

// ---- line layers ----------------------------------------------------------------------

/** Default y range of a line, px either side of its origin. */
export const LINE_Y_RANGE: [number, number] = [-300, 300];

/**
 * Copy of a line layer with origin and step chosen so the visible rows run across the usable
 * width, with the line's zero (origin) at mid-frame. The y range is left alone.
 */
export function fitLineLayer(layer: LineLayer, summary: DatasetSummary): LineLayer {
  const out = structuredClone(layer);
  const tSpan = tSpanOf(layer, summary);
  const [s, e] = visibleFractions(layer);
  const span = Math.max(1, tSpan * (e - s));
  const tStart = layer.followRange ? 0 : tSpan * s;
  const sx = USABLE_W / span;
  out.origin = [finite(MARGIN - tStart * sx, MARGIN), FRAME_H / 2, 0];
  out.step = [finite(sx, 1), 0, 0];
  return out;
}

/**
 * A new line for `dataset`: time mode on the first time column (index mode without one), y
 * from the first varying numeric column over ±300 px, 2 px wide, fitted to the frame.
 */
export function defaultLineLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): LineLayer {
  const layer = blankLineLayer(id, name, dataset.id);
  const time = timeColumns(summary)[0];
  layer.xMode = time ? 'time' : 'index';
  layer.timeColumn = time?.name ?? null;
  const value = firstVaryingNumber(summary);
  layer.y = { ...unmapped([...LINE_Y_RANGE]), column: value?.name ?? null };
  layer.width = 2;
  return fitLineLayer(layer, summary);
}

// ---- heat map layers ------------------------------------------------------------------

/**
 * Copy of a heat map with cell size and origin (its top-left corner) chosen so the visible
 * rows fill the usable frame:
 *   calendar  366 day columns across, one row per visible year (as the instancer's calendar)
 *   grid      roughly square cells, columns chosen for the frame's aspect
 * Cells are placed from the dataset's first year / first row, so with a partial row range
 * the origin moves up to bring the first visible row to the top margin.
 */
export function fitHeatmapLayer(layer: HeatmapLayer, summary: DatasetSummary, timeZone: string): HeatmapLayer {
  const out = structuredClone(layer);
  const [s, e] = visibleFractions(layer);
  if (layer.layout === 'calendar') {
    const { years, yearOffset } = visibleYears(layerTimeColumn(layer, summary), s, e, timeZone, false);
    const w = atLeast(1, USABLE_W / 366);
    const h = atLeast(1, USABLE_H / years);
    out.cell = [w, h];
    out.origin = [MARGIN, finite(FRAME_H - MARGIN + yearOffset * h, FRAME_H - MARGIN), 0];
  } else {
    const tSpan = Math.max(0, finite(summary.rowCount, 0) - 1);
    const span = Math.max(1, tSpan * (e - s));
    const { cols, w, h } = gridFit(Math.floor(span) + 1);
    const firstRow = Math.floor((tSpan * s) / cols);
    out.gridColumns = cols;
    out.cell = [w, h];
    out.origin = [MARGIN, finite(FRAME_H - MARGIN + firstRow * h, FRAME_H - MARGIN), 0];
  }
  return out;
}

/**
 * A new heat map for `dataset`: a year x day-of-year calendar when there is a daily time
 * column, otherwise a grid in row order. Coloured by the first varying numeric column (sqrt
 * scale for non-negative data, as the instancer calendar), fitted to the frame.
 */
export function defaultHeatmapLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): HeatmapLayer {
  const layer = blankHeatmapLayer(id, name, dataset.id);
  const times = timeColumns(summary);
  const daily = times.find((c) => isDailyStep(cadenceStep(summary, c.name)));
  layer.layout = daily ? 'calendar' : 'grid';
  layer.timeColumn = (daily ?? times[0])?.name ?? null;
  const value = firstVaryingNumber(summary);
  if (value) {
    layer.valueColumn = value.name;
    layer.scale = value.min >= 0 ? 'sqrt' : 'linear';
  }
  return fitHeatmapLayer(layer, summary, dataset.timeZone);
}

// ---- text layers ----------------------------------------------------------------------

/** Characters that would break a {Column|format} placeholder. */
const TEMPLATE_UNSAFE = /[{}|]/;

/** Unit from a column name such as "Rainfall [mm]" ("mm"), or "". */
function unitOf(name: string): string {
  return /\[([^\]]+)\]\s*$/.exec(name)?.[1]?.trim() ?? '';
}

/**
 * Text template showing the current row of a dataset: the first time column as a date and
 * the first varying numeric column to one decimal place with its unit, e.g.
 * "{Observation time UTC|date}  {Rainfall [mm]|fixed:1} mm". Null when the dataset has
 * neither (columns whose names can't go in a placeholder are skipped).
 */
export function textTemplateFor(summary: DatasetSummary): string | null {
  const safe = (c: SummaryColumn) => !TEMPLATE_UNSAFE.test(c.name);
  const time = timeColumns(summary).find(safe);
  const numbers = summary.columns.filter((c) => c.type === 'number' && !c.empty && safe(c));
  const value = numbers.find((c) => Number.isFinite(c.min) && Number.isFinite(c.max) && c.max > c.min) ?? numbers[0];
  const parts: string[] = [];
  if (time) parts.push(`{${time.name}|date}`);
  if (value) {
    const unit = unitOf(value.name);
    parts.push(`{${value.name}|fixed:1}${unit ? ` ${unit}` : ''}`);
  }
  return parts.length ? parts.join('  ') : null;
}

const TEXT_ANCHOR_X = { left: MARGIN, center: FRAME_W / 2, right: FRAME_W - MARGIN } as const;
const TEXT_ANCHOR_Y = { top: FRAME_H - MARGIN, middle: FRAME_H / 2, bottom: MARGIN } as const;

/**
 * Copy of a text layer placed inside the frame: its anchor point goes to the matching margin
 * point (a top-left anchor to the top-left margin, a centred one to the frame centre, and so
 * on), and it wraps at the usable width so long text stays on screen.
 */
export function fitTextLayer(layer: TextLayer): TextLayer {
  const out = structuredClone(layer);
  out.position = [TEXT_ANCHOR_X[layer.anchorX], TEXT_ANCHOR_Y[layer.anchorY], 0];
  out.maxWidth = USABLE_W;
  return out;
}

/**
 * A new text layer at the top left, 48 px, anchored left/top. With a parsed dataset its
 * template shows the current row's date and first numeric value (see textTemplateFor);
 * without one it is static text.
 */
export function defaultTextLayerFor(id: string, name: string, dataset: Dataset | null, summary: DatasetSummary | null): TextLayer {
  const layer = blankTextLayer(id, name, dataset?.id ?? null);
  layer.position = [TEXT_ANCHOR_X.left, TEXT_ANCHOR_Y.top, 0];
  layer.fontSize = 48;
  layer.anchorX = 'left';
  layer.anchorY = 'top';
  layer.align = 'left';
  const template = summary ? textTemplateFor(summary) : null;
  if (template !== null) layer.text = template;
  return layer;
}

// ---- any type -------------------------------------------------------------------------

/**
 * A new layer of `type`. Data layers need a dataset and its summary; without them they come
 * back blank (neutral settings, nothing mapped). Text works with or without data.
 */
export function defaultLayerOfType(
  type: LayerType,
  id: string,
  name: string,
  dataset: Dataset | null,
  summary: DatasetSummary | null,
): LayerConfig {
  if (type === 'text') return defaultTextLayerFor(id, name, dataset, summary);
  if (!dataset || !summary) {
    const datasetId = dataset?.id ?? null;
    if (type === 'line') return blankLineLayer(id, name, datasetId);
    if (type === 'heatmap') return blankHeatmapLayer(id, name, datasetId);
    if (type === 'multiples') return blankMultiplesLayer(id, name, datasetId);
    if (type === 'hierarchy') return blankHierarchyLayer(id, name, datasetId);
    if (type === 'surface') return blankSurfaceLayer(id, name, datasetId);
    return blankInstancerLayer(id, name, datasetId);
  }
  // Phase 7 types: data-aware defaults arrive with their control UI.
  if (type === 'multiples') return blankMultiplesLayer(id, name, dataset.id);
  if (type === 'hierarchy') return blankHierarchyLayer(id, name, dataset.id);
  if (type === 'surface') return blankSurfaceLayer(id, name, dataset.id);
  if (type === 'line') return defaultLineLayerFor(id, name, dataset, summary);
  if (type === 'heatmap') return defaultHeatmapLayerFor(id, name, dataset, summary);
  return defaultLayerFor(id, name, dataset, summary);
}

/**
 * Fit any layer to the output frame (see the per-type fits). Data layers need their
 * dataset's summary; without one they come back unchanged (as a copy).
 */
export function fitAnyLayer(layer: LayerConfig, summary: DatasetSummary | null, timeZone: string): LayerConfig {
  if (layer.type === 'text') return fitTextLayer(layer);
  if (!summary) return structuredClone(layer);
  switch (layer.type) {
    case 'instancer':
      return fitLayer(layer, summary, timeZone);
    case 'line':
      return fitLineLayer(layer, summary);
    case 'heatmap':
      return fitHeatmapLayer(layer, summary, timeZone);
    default:
      // Phase 7 types get their fits with their control UI.
      return structuredClone(layer);
  }
}
