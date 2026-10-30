/**
 * Sensible starting layouts for every layer type. Pure: no DOM or Node APIs, so both windows
 * and the tests can use it.
 *
 * `defaultLayerFor` picks an instancer view for a dataset (calendar for daily time series,
 * bars for other time series or plain row order), and `fitLayer` sizes the arrangement so the
 * visible rows fill the 1920x1080 output frame inside a 60 px margin. The line, heat map and
 * text layers, and the phase 7 small multiples, hierarchy and surface layers, have their own
 * `default*LayerFor` / `fit*Layer` pairs; `defaultLayerOfType` and `fitAnyLayer` dispatch on
 * the type.
 */

import type { ColumnType, Table } from '../data/columns.ts';
import {
  blankDensityLayer,
  blankHorizonLayer,
  blankHeatmapLayer,
  blankHierarchyLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankMultiplesLayer,
  blankQrLayer,
  blankReflectorLayer,
  blankSurfaceLayer,
  blankTextLayer,
  unmapped,
  type DensityLayer,
  type HorizonLayer,
  type HeatmapLayer,
  type HierarchyLayer,
  type HierarchyLevel,
  type InstancerLayer,
  type LayerConfig,
  type LayerType,
  type LineLayer,
  type ReflectorLayer,
  type SmallMultiplesLayer,
  type SurfaceLayer,
  type TextLayer,
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
  /** Distinct values of a category column (undefined for other types or when unknown). */
  categories?: number;
  /** Missing values (undefined when unknown). */
  nullCount?: number;
  /**
   * Number columns: the 5th and 95th percentiles of the values (from a sample of at most
   * 2048 rows), so a column that is nearly always one value (with rare outliers) can be told
   * from one that varies. Undefined for other types or when unknown.
   */
  typical?: [number, number];
  /**
   * Distinct values, in first-seen order, of a category column, or of a text column with at
   * most FILTER_VALUES of them: the choices a row filter offers. Undefined otherwise.
   */
  values?: string[];
}

/** Most distinct values of a text column listed as row filter choices. */
export const FILTER_VALUES = 100;

/** Distinct non-missing texts in first-seen order, or undefined past FILTER_VALUES. */
function distinctTexts(values: readonly (string | null)[]): string[] | undefined {
  const seen = new Set<string>();
  for (const v of values) {
    if (v === null || seen.has(v)) continue;
    if (seen.size === FILTER_VALUES) return undefined;
    seen.add(v);
  }
  return [...seen];
}

/** Rows sampled for a number column's typical range. */
const TYPICAL_SAMPLE = 2048;

/** 5th and 95th percentiles of a sample of the non-missing values, or undefined with none. */
function typicalRange(values: Float32Array): [number, number] | undefined {
  const step = Math.max(1, Math.floor(values.length / TYPICAL_SAMPLE));
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    const v = values[i]!;
    if (!Number.isNaN(v)) sample.push(v);
  }
  if (sample.length === 0) return undefined;
  sample.sort((a, b) => a - b);
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(q * (sample.length - 1)))]!;
  return [at(0.05), at(0.95)];
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
    columns: table.columns.map((c) => {
      const col: SummaryColumn = { name: c.name, type: c.type, min: c.min, max: c.max, empty: c.empty, nullCount: c.nullCount };
      if (c.type === 'category') {
        col.categories = c.dictionary.length;
        col.values = [...c.dictionary];
      }
      if (c.type === 'text' && !c.empty) col.values = distinctTexts(c.values);
      if (c.type === 'number') col.typical = typicalRange(c.values);
      return col;
    }),
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

/** Non-empty category columns. */
export function categoryColumns(summary: DatasetSummary): SummaryColumn[] {
  return summary.columns.filter((c) => c.type === 'category' && !c.empty);
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

/** Calendar year and month (1..12) of an epoch-ms instant in a timezone; UTC when the zone is unusable. */
function calendarIn(ms: number, timeZone: string): { year: number; month: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-NZ', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(ms);
    const year = Number(parts.find((p) => p.type === 'year')?.value);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    if (Number.isFinite(year) && Number.isFinite(month)) return { year, month };
  } catch {
    // fall through to UTC
  }
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Calendar year of an epoch-ms instant in a timezone; UTC when the zone is unusable. */
function yearIn(ms: number, timeZone: string): number {
  return calendarIn(ms, timeZone).year;
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
      x: copyMapping(layer.channels.x),
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
/** A line chart with axes (x or y axis on): the line spans CHART_LEFT .. frame - CHART_RIGHT over CHART_BASE .. + CHART_HEIGHT. */
export const CHART_LEFT = 200;
const CHART_RIGHT = 80;
export const CHART_BASE = 170;
export const CHART_HEIGHT = 720;

export function fitLineLayer(layer: LineLayer, summary: DatasetSummary): LineLayer {
  const out = structuredClone(layer);
  const tSpan = tSpanOf(layer, summary);
  const [s, e] = visibleFractions(layer);
  const span = Math.max(1, tSpan * (e - s));
  const tStart = layer.followRange ? 0 : tSpan * s;
  // With axes on, leave room for them: the value axis on the left, labels below the baseline.
  const charted = layer.axes.x.enabled || layer.axes.y.enabled;
  const left = charted ? CHART_LEFT : MARGIN;
  const sx = (charted ? FRAME_W - CHART_LEFT - CHART_RIGHT : USABLE_W) / span;
  out.origin = [finite(left - tStart * sx, left), charted ? CHART_BASE : FRAME_H / 2, 0];
  out.step = [finite(sx, 1), 0, 0];
  if (charted) out.y = { ...out.y, range: [0, CHART_HEIGHT] };
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
  return fitCells(layer, summary, timeZone);
}

/** The fields a cell layout (heat map or 3D surface) is placed by. */
type CellLayer = Pick<HeatmapLayer, 'layout' | 'timeColumn' | 'rows' | 'gridColumns' | 'origin' | 'cell'>;

/** Copy of a heat map or surface with its cells fitted to the frame (see fitHeatmapLayer). */
function fitCells<L extends CellLayer>(layer: L, summary: DatasetSummary, timeZone: string): L {
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

// ---- small multiples ------------------------------------------------------------------

/** Panel width / height the multiples fit aims for (wide panels suit time series). */
const PANEL_ASPECT = 1.6;
/** Largest gap between panels px; smaller panels get proportionally smaller gaps. */
const MAX_PANEL_GAP = 8;
/** Panel heights px from which titles are drawn at 24 px (the projection minimum) or 14 px. */
const PANEL_LABEL_BIG = 160;
const PANEL_LABEL_SMALL = 60;
/** Panels a `rows` split aims for by default. */
const ROW_SPLIT_PANELS = 60;

/** Default title size for panels `h` px tall: 24 when they are big, 14 when they still fit it, else off. */
export function panelLabelSize(h: number): number {
  if (h >= PANEL_LABEL_BIG) return 24;
  if (h >= PANEL_LABEL_SMALL) return 14;
  return 0;
}

/**
 * How many panels a small multiples layer shows for its visible rows: the calendar years,
 * months or decades spanned (an upper bound, in case years with no data get no panel), the
 * distinct values of the category column, or visible rows / chunk size. Never below 1.
 */
export function panelCount(layer: SmallMultiplesLayer, summary: DatasetSummary, timeZone: string): number {
  const [s, e] = visibleFractions(layer);
  switch (layer.splitBy) {
    case 'year':
    case 'month':
    case 'decade': {
      const col = timeColumns(summary).find((c) => c.name === layer.splitColumn);
      if (!col) return 1;
      const range = col.max - col.min;
      const a = calendarIn(col.min + range * s, timeZone);
      const b = calendarIn(col.min + range * e, timeZone);
      const n =
        layer.splitBy === 'year'
          ? b.year - a.year + 1
          : layer.splitBy === 'month'
            ? (b.year - a.year) * 12 + b.month - a.month + 1
            : Math.floor(b.year / 10) - Math.floor(a.year / 10) + 1;
      return Math.max(1, finite(n, 1));
    }
    case 'category': {
      const col = categoryColumns(summary).find((c) => c.name === layer.splitColumn);
      return Math.max(1, finite(col?.categories ?? 1, 1));
    }
    case 'rows': {
      const rows = Math.max(0, finite(summary.rowCount, 0)) * (e - s);
      return Math.max(1, finite(Math.ceil(rows / Math.max(1, layer.chunkRows)), 1));
    }
  }
}

/**
 * Panels per line, panel size and gap so `n` panels fill the usable frame: the column count
 * whose panels come closest to PANEL_ASPECT, with gaps of about 6% of a panel (at most 8 px).
 */
export function panelGrid(n: number): { columns: number; panel: [number, number]; gap: [number, number] } {
  const count = Math.max(1, Math.floor(finite(n, 1)));
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const score = Math.abs(Math.log(USABLE_W / cols / (USABLE_H / rows) / PANEL_ASPECT));
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  const rows = Math.ceil(count / best);
  const gap = Math.min(MAX_PANEL_GAP, Math.min(USABLE_W / best, USABLE_H / rows) * 0.06);
  const w = atLeast(1, (USABLE_W - (best - 1) * gap) / best);
  const h = atLeast(1, (USABLE_H - (rows - 1) * gap) / rows);
  return { columns: best, panel: [w, h], gap: [gap, gap] };
}

/**
 * Copy of a small multiples layer with its panel grid (panels per line, panel size, gap)
 * chosen so the visible panels fill the usable frame, the first one at the top-left margin.
 */
export function fitMultiplesLayer(layer: SmallMultiplesLayer, summary: DatasetSummary, timeZone: string): SmallMultiplesLayer {
  const out = structuredClone(layer);
  const { columns, panel, gap } = panelGrid(panelCount(layer, summary, timeZone));
  out.columns = columns;
  out.panelSize = panel;
  out.gap = gap;
  out.origin = [MARGIN, FRAME_H - MARGIN, 0];
  return out;
}

/**
 * A new small multiples layer: one panel per year of the first time column (per category of
 * the first category column without one, otherwise chunks of rows), bars of the first
 * varying numeric column coloured by value (sqrt scale for non-negative data), fitted to the
 * frame, with panel titles when the panels are big enough to carry them.
 */
export function defaultMultiplesLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): SmallMultiplesLayer {
  const layer = blankMultiplesLayer(id, name, dataset.id);
  const time = timeColumns(summary)[0];
  const category = categoryColumns(summary)[0];
  if (time) {
    layer.splitBy = 'year';
    layer.splitColumn = time.name;
  } else if (category) {
    layer.splitBy = 'category';
    layer.splitColumn = category.name;
  } else {
    layer.splitBy = 'rows';
    layer.splitColumn = null;
    layer.chunkRows = Math.max(1, Math.ceil(Math.max(0, finite(summary.rowCount, 0)) / ROW_SPLIT_PANELS));
  }
  const value = firstVaryingNumber(summary);
  layer.valueColumn = value?.name ?? null;
  layer.scale = value && value.min < 0 ? 'linear' : 'sqrt';
  layer.chart = 'bars';
  layer.colourByValue = value !== undefined;
  layer.ramp = 'viridis';
  const fitted = fitMultiplesLayer(layer, summary, dataset.timeZone);
  fitted.labelSize = panelLabelSize(fitted.panelSize[1]);
  return fitted;
}

// ---- hierarchy ------------------------------------------------------------------------

/** True for hierarchy layouts drawn in a circle (radial dendrogram, sunburst, pack), which fit a square. */
export function isRoundLayout(layout: HierarchyLayer['layout']): boolean {
  return layout === 'radial-dendrogram' || layout === 'sunburst' || layout === 'pack';
}

/**
 * Copy of a hierarchy with its box fitted to the frame: a centred square of the usable
 * height for round layouts, the whole usable frame for the others.
 */
export function fitHierarchyLayer(layer: HierarchyLayer): HierarchyLayer {
  const out = structuredClone(layer);
  if (isRoundLayout(layer.layout)) {
    out.origin = [(FRAME_W - USABLE_H) / 2, FRAME_H - MARGIN, 0];
    out.size = [USABLE_H, USABLE_H];
  } else {
    out.origin = [MARGIN, FRAME_H - MARGIN, 0];
    out.size = [USABLE_W, USABLE_H];
  }
  return out;
}

/** Default levels: decade then year of the first time column, or the first category column; null with neither. */
export function defaultHierarchyLevels(summary: DatasetSummary): HierarchyLevel[] | null {
  const time = timeColumns(summary)[0];
  if (time) {
    return [
      { kind: 'time', column: time.name, unit: 'decade' },
      { kind: 'time', column: time.name, unit: 'year' },
    ];
  }
  const category = categoryColumns(summary)[0];
  return category ? [{ kind: 'category', column: category.name }] : null;
}

/**
 * A new hierarchy: decade -> year of the first time column (or the first category column),
 * summing the first varying numeric column, drawn as a radial dendrogram in a centred square
 * with nodes coloured by value (sqrt scale for non-negative data).
 */
export function defaultHierarchyLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): HierarchyLayer {
  const layer = blankHierarchyLayer(id, name, dataset.id);
  const levels = defaultHierarchyLevels(summary);
  if (levels) layer.levels = levels;
  const value = firstVaryingNumber(summary);
  layer.valueColumn = value?.name ?? null;
  layer.aggregate = 'sum';
  layer.scale = value && value.min < 0 ? 'linear' : 'sqrt';
  layer.colourBy = value ? 'value' : 'depth';
  layer.layout = 'radial-dendrogram';
  return fitHierarchyLayer(layer);
}

// ---- 3D surface -----------------------------------------------------------------------

/** Default height range of a surface, px along +z. */
export const SURFACE_HEIGHT: [number, number] = [0, 200];

/** Copy of a surface with its cells fitted to the frame, exactly as the heat map's (fitHeatmapLayer). */
export function fitSurfaceLayer(layer: SurfaceLayer, summary: DatasetSummary, timeZone: string): SurfaceLayer {
  return fitCells(layer, summary, timeZone);
}

/**
 * A new surface: a year x day-of-year calendar when there is a daily time column, otherwise
 * a grid in row order; height 0..200 px from the first varying numeric column (sqrt scale for
 * non-negative data), fitted to the frame like the heat map.
 */
export function defaultSurfaceLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): SurfaceLayer {
  const layer = blankSurfaceLayer(id, name, dataset.id);
  const times = timeColumns(summary);
  const daily = times.find((c) => isDailyStep(cadenceStep(summary, c.name)));
  layer.layout = daily ? 'calendar' : 'grid';
  layer.timeColumn = (daily ?? times[0])?.name ?? null;
  const value = firstVaryingNumber(summary);
  layer.valueColumn = value?.name ?? null;
  layer.scale = value && value.min < 0 ? 'linear' : 'sqrt';
  layer.height = [SURFACE_HEIGHT[0], SURFACE_HEIGHT[1]];
  return fitSurfaceLayer(layer, summary, dataset.timeZone);
}

// ---- reflection plane -----------------------------------------------------------------

/**
 * Copy of a reflection plane sized to the frame (1920 wide, 1080 deep). Its placement is the
 * layer transform's (a new plane lies flat along the bottom of the frame; see floorTransform),
 * which a fit leaves alone.
 */
export function fitReflectorLayer(layer: ReflectorLayer): ReflectorLayer {
  const out = structuredClone(layer);
  out.size = [FRAME_W, FRAME_H];
  return out;
}

// ---- any type -------------------------------------------------------------------------

/**
 * A new layer of `type`. Data layers need a dataset and its summary; without them they come
 * back blank (neutral settings, nothing mapped). Text works with or without data; a
 * reflection plane never has a dataset.
 */
export function defaultLayerOfType(
  type: LayerType,
  id: string,
  name: string,
  dataset: Dataset | null,
  summary: DatasetSummary | null,
): LayerConfig {
  if (type === 'text') return defaultTextLayerFor(id, name, dataset, summary);
  if (type === 'reflector') return blankReflectorLayer(id, name);
  if (type === 'qr') return blankQrLayer(id, name, dataset?.id ?? null);
  if (!dataset || !summary) {
    const datasetId = dataset?.id ?? null;
    if (type === 'line') return blankLineLayer(id, name, datasetId);
    if (type === 'heatmap') return blankHeatmapLayer(id, name, datasetId);
    if (type === 'density') return blankDensityLayer(id, name, datasetId);
    if (type === 'horizon') return blankHorizonLayer(id, name, datasetId);
    if (type === 'multiples') return blankMultiplesLayer(id, name, datasetId);
    if (type === 'hierarchy') return blankHierarchyLayer(id, name, datasetId);
    if (type === 'surface') return blankSurfaceLayer(id, name, datasetId);
    return blankInstancerLayer(id, name, datasetId);
  }
  if (type === 'multiples') return defaultMultiplesLayerFor(id, name, dataset, summary);
  if (type === 'hierarchy') return defaultHierarchyLayerFor(id, name, dataset, summary);
  if (type === 'surface') return defaultSurfaceLayerFor(id, name, dataset, summary);
  if (type === 'line') return defaultLineLayerFor(id, name, dataset, summary);
  if (type === 'heatmap') return defaultHeatmapLayerFor(id, name, dataset, summary);
  if (type === 'density') return defaultDensityLayerFor(id, name, dataset, summary);
  if (type === 'horizon') return defaultHorizonLayerFor(id, name, dataset, summary);
  return defaultLayerFor(id, name, dataset, summary);
}

/**
 * Fit any layer to the output frame (see the per-type fits). Data layers need their
 * dataset's summary; without one they come back unchanged (as a copy).
 */
export function fitAnyLayer(layer: LayerConfig, summary: DatasetSummary | null, timeZone: string): LayerConfig {
  if (layer.type === 'text') return fitTextLayer(layer);
  if (layer.type === 'reflector') return fitReflectorLayer(layer);
  if (layer.type === 'qr') return structuredClone(layer);
  if (!summary) return structuredClone(layer);
  switch (layer.type) {
    case 'instancer':
      return fitLayer(layer, summary, timeZone);
    case 'line':
      return fitLineLayer(layer, summary);
    case 'heatmap':
      return fitHeatmapLayer(layer, summary, timeZone);
    case 'multiples':
      return fitMultiplesLayer(layer, summary, timeZone);
    case 'hierarchy':
      return fitHierarchyLayer(layer);
    case 'surface':
      return fitSurfaceLayer(layer, summary, timeZone);
    case 'density':
      return fitDensityLayer(layer, summary);
    case 'horizon':
      return fitHorizonLayer(layer, summary);
  }
}

/** px left of a horizon chart's strips (room for the series names) and the tallest strip. */
const HORIZON_LEFT = 260;
const HORIZON_MAX_STRIP = 160;

/**
 * Horizon chart fit: strips from the top margin down, as tall as fit the frame (at most
 * HORIZON_MAX_STRIP px each), from HORIZON_LEFT to the right margin. Picks a value column when
 * none is set, and the time mode when there is a time column.
 */
export function fitHorizonLayer(layer: HorizonLayer, summary: DatasetSummary): HorizonLayer {
  const out = structuredClone(layer);
  if (out.valueColumn === null || !summary.columns.some((c) => c.name === out.valueColumn && c.type === 'number')) {
    out.valueColumn = firstVaryingNumber(summary)?.name ?? null;
  }
  const times = timeColumns(summary);
  if (out.timeColumn === null || !times.some((c) => c.name === out.timeColumn)) out.timeColumn = times[0]?.name ?? null;
  if (out.xMode === 'time' && out.timeColumn === null) out.xMode = 'index';
  const strips = out.seriesColumn === null ? 1 : Math.max(1, summary.columns.find((c) => c.name === out.seriesColumn)?.values?.length ?? 1);
  const usable = FRAME_H - 2 * MARGIN;
  out.gap = strips > 1 ? Math.min(out.gap, 24) : out.gap;
  const h = Math.max(8, Math.min(HORIZON_MAX_STRIP, (usable - (strips - 1) * out.gap) / strips));
  out.origin = [HORIZON_LEFT, FRAME_H - MARGIN, 0];
  out.size = [FRAME_W - HORIZON_LEFT - MARGIN, Math.round(h)];
  return out;
}

export function defaultHorizonLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): HorizonLayer {
  const layer = blankHorizonLayer(id, name, dataset.id);
  layer.xMode = timeColumns(summary).length > 0 ? 'time' : 'index';
  return fitHorizonLayer(layer, summary);
}

/** px between a density map and the frame edge (room for axes or a title). */
const DENSITY_MARGIN = 120;
/** Bins across a fitted density map (down follows the map's aspect). */
const DENSITY_BINS_X = 320;

/**
 * Density map fit: the frame less DENSITY_MARGIN all round, square bins, and columns when none
 * are set: x the time column (else the first varying number), y the first other varying number.
 */
export function fitDensityLayer(layer: DensityLayer, summary: DatasetSummary): DensityLayer {
  const out = structuredClone(layer);
  const names = new Set(summary.columns.filter((c) => !c.empty && (c.type === 'number' || c.type === 'time')).map((c) => c.name));
  const varying = summary.columns.filter((c) => c.type === 'number' && !c.empty && Number.isFinite(c.min) && c.max > c.min).map((c) => c.name);
  if (out.xColumn === null || !names.has(out.xColumn)) out.xColumn = timeColumns(summary)[0]?.name ?? varying[0] ?? null;
  if (out.yColumn === null || !names.has(out.yColumn)) out.yColumn = varying.find((n) => n !== out.xColumn) ?? null;
  const w = FRAME_W - 2 * DENSITY_MARGIN;
  const h = FRAME_H - 2 * DENSITY_MARGIN;
  out.origin = [DENSITY_MARGIN, DENSITY_MARGIN, 0];
  out.size = [w, h];
  if (out.zColumn !== null && !names.has(out.zColumn)) out.zColumn = null;
  // Dots are coarser than a flat map's pixels; 3D bins coarser still (they cost cells × depth).
  const across = out.mode === 'flat' ? DENSITY_BINS_X : out.zColumn === null ? 96 : 64;
  out.bins = [across, Math.max(4, Math.round((across * h) / w))];
  if (out.mode === 'dots' && out.zColumn !== null) {
    out.binsZ = Math.max(2, Math.round((across * out.depth) / w));
    out.origin = [DENSITY_MARGIN, DENSITY_MARGIN, -out.depth / 2];
  }
  return out;
}

export function defaultDensityLayerFor(id: string, name: string, dataset: Dataset, summary: DatasetSummary): DensityLayer {
  return fitDensityLayer(blankDensityLayer(id, name, dataset.id), summary);
}
