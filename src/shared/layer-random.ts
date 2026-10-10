import {
  categoryColumns,
  fitAnyLayer,
  isDailyStep,
  panelLabelSize,
  timeColumns,
  type DatasetSummary,
  type SummaryColumn,
} from './layer-defaults.ts';
import { edgePreset, FRAME_BUDGET, ridgelineCloner, ridgelineLine, visibleRowCount } from './layer-helpers.ts';
import {
  defaultEdges,
  defaultLayerEffects,
  HIERARCHY_LAYOUTS,
  identityCloner,
  type ColourRamp,
  type HeatmapLayer,
  type HierarchyLayer,
  type InstancerLayer,
  type LayerConfig,
  type LineLayer,
  type QrLayer,
  type ReflectorLayer,
  type ScaleType,
  type SmallMultiplesLayer,
  type SurfaceLayer,
  type TextLayer,
} from './layer-schema.ts';

/**
 * "Randomise" for a layer's General folder: a fresh look from a handful of hand-made recipes
 * per layer type, varied a little (ramp, colour, sizes, effects), then fitted to the output.
 *
 *   look  keeps what the data says: the dataset, and which columns drive height, colour, y
 *         and so on (an instancer without a time column may take one for a calendar or a
 *         time axis). Only the visual treatment changes.
 *   all   also picks the columns (from the dataset's varying numbers, times and categories)
 *         and, for lines and multiples, the aggregation and split.
 *
 * Always kept: id, name, on/off, dataset, transform, timeline, fixed to screen. Effects start
 * from off and only glow (and a recipe's own blend) is switched on; trails, shadow and blur
 * stay off, as they cost GPU time. Colours suit the background (bright on dark, deep on
 * light); lines stay at least 2 px and text at least 24 px (projection minimums). Clone
 * counts are capped so the layer alone stays within FRAME_BUDGET.
 *
 * Pure and deterministic for a given `rng`, so it is testable; the control window seeds it
 * with Math.random.
 */

export const RANDOM_SCOPES = ['look', 'all'] as const;
export type RandomScope = (typeof RANDOM_SCOPES)[number];

/** Random numbers in [0, 1). */
export type Rng = () => number;

/** A small, fast seeded generator (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ramps that read well on a projector (no white-ended single-hue ramps). */
const RAMPS: readonly ColourRamp[] = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'spectral'];

interface Ctx {
  rng: Rng;
  summary: DatasetSummary | null;
  scope: RandomScope;
  background: string;
  /** True on a dark background (bright marks). */
  dark: boolean;
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] ?? xs[0]!;
const between = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();
const chance = (rng: Rng, p: number): boolean => rng() < p;
/** `v` to the nearest `step`, as a clean decimal (0.6, not 0.6000000000000001). */
const round = (v: number, step: number): number => Number((Math.round(v / step) * step).toFixed(6));

function hex(n: number): string {
  return Math.round(Math.min(Math.max(n, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** #rrggbb from hue (degrees), saturation and lightness (0..1). */
export function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Relative luminance 0..1 of a #rrggbb colour (sRGB). */
export function luminance(colour: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!m) return 0;
  const lin = (c: string) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!);
}

/** WCAG contrast ratio of two colours (1..21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast a mark colour needs against the background (WCAG AA for text). */
const MIN_CONTRAST = 4.5;

/**
 * A saturated colour that stands out on the background: a random hue, made lighter (dark
 * background) or darker (light background) until it has MIN_CONTRAST, since hues differ a lot
 * in brightness (yellow is bright, blue dark).
 */
function accent(ctx: Ctx): string {
  const { rng } = ctx;
  const h = between(rng, 0, 360);
  const sat = between(rng, 0.65, 0.95);
  let l = ctx.dark ? between(rng, 0.58, 0.7) : between(rng, 0.3, 0.42);
  for (let i = 0; i < 12; i++) {
    const c = hslHex(h, sat, l);
    if (contrast(c, ctx.background) >= MIN_CONTRAST) return c;
    l = ctx.dark ? Math.min(0.95, l + 0.04) : Math.max(0.05, l - 0.04);
  }
  return ink(ctx);
}

/** Near-white (dark background) or near-black (light background). */
function ink(ctx: Ctx): string {
  return ctx.dark ? '#f2f2f2' : '#141414';
}

/** Share of missing values above which 'all' passes a column over when it has better ones. */
const MOSTLY_MISSING = 0.2;

/**
 * Non-empty numeric columns that vary, best first: those whose typical values vary (not one
 * value with rare outliers) and that are mostly filled in (a column missing for decades makes
 * a layer that is half blank), when there are any.
 */
function numbers(summary: DatasetSummary): SummaryColumn[] {
  const all = summary.columns.filter((c) => c.type === 'number' && !c.empty && Number.isFinite(c.min) && Number.isFinite(c.max) && c.max > c.min);
  const varied = (c: SummaryColumn) => !c.typical || c.typical[1] > c.typical[0];
  const filled = (c: SummaryColumn) => (c.nullCount ?? 0) <= MOSTLY_MISSING * summary.rowCount;
  for (const keep of [(c: SummaryColumn) => varied(c) && filled(c), varied, filled]) {
    const best = all.filter(keep);
    if (best.length > 0) return best;
  }
  return all;
}

function column(summary: DatasetSummary | null, name: string | null): SummaryColumn | undefined {
  return name === null ? undefined : summary?.columns.find((c) => c.name === name);
}

/** A scale that suits the column's values: log needs positive values somewhere, sqrt no negatives. */
function scaleFor(ctx: Ctx, col: SummaryColumn | undefined): ScaleType {
  if (!col || col.type !== 'number' || !(col.min >= 0)) return 'linear';
  const options: ScaleType[] = col.max > 0 && col.max / Math.max(col.min, 1e-9) > 100 ? ['linear', 'sqrt', 'sqrt', 'log'] : ['linear', 'sqrt'];
  return pick(ctx.rng, options);
}

/** The time column a layer could use: its own, or the dataset's first (daily ones first). */
function timeColumnFor(ctx: Ctx, current: string | null): string | null {
  if (!ctx.summary) return current;
  const times = timeColumns(ctx.summary);
  if (ctx.scope === 'all' && times.length > 0) return pick(ctx.rng, times).name;
  if (current !== null && times.some((c) => c.name === current)) return current;
  const daily = times.find((c) => isDailyStep(ctx.summary!.cadences[c.name]?.step ?? NaN));
  return (daily ?? times[0])?.name ?? null;
}

function isDaily(ctx: Ctx, timeColumn: string | null): boolean {
  return timeColumn !== null && isDailyStep(ctx.summary?.cadences[timeColumn]?.step ?? NaN);
}

/** A random varying numeric column ('all' scope), or `current`. */
function valueColumn(ctx: Ctx, current: string | null): string | null {
  if (ctx.scope !== 'all' || !ctx.summary) return current;
  const nums = numbers(ctx.summary);
  return nums.length > 0 ? pick(ctx.rng, nums).name : current;
}

/**
 * Marks a layer draws above which it counts as dense: packed marks overlap, so additive
 * blending and a strong glow would wash the layer out to white.
 */
const DENSE_MARKS = 4000;

/**
 * Switch the layer's glow on with probability `p`: soft and only on the brightest parts for a
 * dense layer (`marks` > DENSE_MARKS), stronger (and additive on a dark background, when
 * `additive`) for a sparse one.
 */
function glow(ctx: Ctx, out: { effects: LayerConfig['effects']; blend: LayerConfig['blend'] }, p: number, marks: number, additive = true): void {
  const { rng } = ctx;
  if (!chance(rng, p)) return;
  const dense = marks > DENSE_MARKS;
  out.effects.glow = dense
    ? { enabled: true, strength: round(between(rng, 0.3, 0.6), 0.05), radius: round(between(rng, 0.2, 0.45), 0.05), threshold: round(between(rng, 0.5, 0.75), 0.05) }
    : { enabled: true, strength: round(between(rng, 0.6, 1.2), 0.05), radius: round(between(rng, 0.3, 0.6), 0.05), threshold: round(between(rng, 0.2, 0.4), 0.05) };
  if (additive && !dense && ctx.dark) out.blend = 'additive';
}

// ---- per type --------------------------------------------------------------------------

const INSTANCER_RECIPES = ['calendar', 'bars', 'spiral', 'radial', 'boxes', 'waterfall'] as const;
/** Recipes where a mapped height reads (bars and boxes); the others draw marks of one size. */
const HEIGHT_RECIPES: readonly string[] = ['bars', 'radial', 'boxes'];

function instancer(layer: InstancerLayer, ctx: Ctx): InstancerLayer {
  const { rng, summary } = ctx;
  const out = structuredClone(layer);
  const time = timeColumnFor(ctx, layer.timeColumn);
  const rows = summary ? visibleRowCount(summary.rowCount, layer.rows) : 0;
  // Keeping the mapping ('look'), a mapped height limits the recipes to those that show it, and
  // a calendar or grid of boxes needs a column to colour (or raise) them, or it is a flat slab.
  const look = ctx.scope === 'look';
  const keepHeight = look && layer.channels.height.column !== null;
  const coloured = !look || layer.channels.colour.column !== null;
  const recipes = INSTANCER_RECIPES.filter(
    (r) =>
      (r !== 'calendar' || (time !== null && coloured)) &&
      (r !== 'boxes' || coloured || keepHeight) &&
      (r !== 'waterfall' || rows * 8 <= FRAME_BUDGET) &&
      (!keepHeight || HEIGHT_RECIPES.includes(r)),
  );
  const recipe = pick(rng, recipes);

  if (ctx.scope === 'all' && summary) {
    const nums = numbers(summary);
    // Colour by category only with a few distinct values (two, one of them rare, reads as one colour).
    const cats = categoryColumns(summary).filter((c) => (c.categories ?? 0) >= 3 && (c.categories ?? 0) <= 12);
    const value = nums.length > 0 ? pick(rng, nums).name : null;
    const colourCol = cats.length > 0 && chance(rng, 0.25) ? pick(rng, cats).name : nums.length > 0 && chance(rng, 0.5) ? pick(rng, nums).name : value;
    for (const ch of ['y', 'z', 'size', 'rotation', 'opacity'] as const) out.channels[ch].column = null;
    out.channels.height.column = HEIGHT_RECIPES.includes(recipe) ? value : null;
    out.channels.colour.column = colourCol;
  }
  for (const ch of ['height', 'size', 'y', 'z', 'opacity'] as const) out.channels[ch].domain = null;
  out.channels.colour.domain = null;
  out.channels.height.scale = scaleFor(ctx, column(summary, out.channels.height.column));
  out.channels.colour.scale = scaleFor(ctx, column(summary, out.channels.colour.column));
  out.channels.colour.ramp = pick(rng, RAMPS);
  out.channels.colour.reverse = chance(rng, 0.2);
  out.colour = chance(rng, 0.5) ? accent(ctx) : ink(ctx);
  out.cloner = identityCloner();
  out.edges = defaultEdges();
  out.heightAxis = 'y';
  if (time !== null) {
    out.timeColumn = time;
    out.xMode = 'time';
  }

  switch (recipe) {
    case 'calendar':
      out.arrangement = 'calendar';
      out.primitive = 'square';
      glow(ctx, out, 0.25, rows, false);
      break;
    case 'bars':
      out.arrangement = 'linear';
      out.primitive = 'bar';
      glow(ctx, out, 0.5, rows);
      break;
    case 'spiral':
      out.arrangement = 'spiral';
      out.primitive = pick(rng, ['point', 'square', 'sphere'] as const);
      glow(ctx, out, 0.6, rows);
      break;
    case 'radial':
      out.arrangement = 'radial';
      out.primitive = 'bar';
      // Out from the ring (radius 400), staying inside the frame.
      out.channels.height.range = [2, Math.round(between(rng, 60, 120))];
      glow(ctx, out, 0.5, rows);
      break;
    case 'boxes': {
      out.arrangement = time !== null && chance(rng, 0.6) ? 'calendar' : 'grid';
      out.heightAxis = 'z';
      out.channels.height.range = [2, Math.round(between(rng, 60, 220))];
      // Edges need boxes big enough to see them; packed small boxes are drawn solid.
      if (rows > DENSE_MARKS) {
        out.primitive = 'box';
        glow(ctx, out, 0.3, rows);
        return out;
      }
      const styled = edgePreset(out, chance(rng, 0.5) ? 'neon' : 'outline');
      styled.edges.colour = accent(ctx);
      styled.edges.faceOpacity = round(between(rng, 0.1, 1), 0.05);
      return styled;
    }
    case 'waterfall':
      out.arrangement = 'linear';
      out.primitive = pick(rng, ['point', 'square'] as const);
      out.cloner = { ...out.cloner, ...ridgelineCloner(out, summary), count: Math.max(2, Math.min(40, Math.floor(FRAME_BUDGET / Math.max(1, rows)))) };
      out.cloner.colourByClone = chance(rng, 0.4);
      glow(ctx, out, 0.4, rows * out.cloner.count);
      break;
  }
  return out;
}

const LINE_RECIPES = ['glow', 'value colour', 'area', 'ridgeline'] as const;

function line(layer: LineLayer, ctx: Ctx): { layer: LineLayer; fitted: boolean } {
  const { rng, summary } = ctx;
  let out = structuredClone(layer);
  // A ridgeline narrows the rows to its first year; the next look starts from all of them.
  if (layer.cloner.count > 1 && layer.fill.mode === 'below') out.rows = [0, 1];
  out.cloner = identityCloner();
  out.fill = { mode: 'none', colour: ctx.background, opacity: 1 };
  out.colourMap.column = null;
  out.y.domain = null;
  if (ctx.scope === 'all') {
    out.y.column = valueColumn(ctx, out.y.column);
    out.timeColumn = timeColumnFor(ctx, out.timeColumn);
    out.xMode = out.timeColumn !== null ? 'time' : 'index';
    out.aggregate = isDaily(ctx, out.timeColumn)
      ? { by: pick(rng, ['none', 'week', 'month', 'month', 'year'] as const), rows: 30, fn: pick(rng, ['mean', 'mean', 'max', 'sum'] as const) }
      : { by: 'none', rows: 30, fn: 'mean' };
  }
  out.y.scale = scaleFor(ctx, column(summary, out.y.column));
  out.width = round(between(rng, 2, 4), 0.5);
  out.colour = chance(rng, 0.6) ? accent(ctx) : ink(ctx);
  const recipe = pick(rng, LINE_RECIPES);
  switch (recipe) {
    case 'glow':
      glow(ctx, out, 1, 0);
      break;
    case 'value colour':
      out.colourMap = { ...out.colourMap, column: out.y.column, scale: out.y.scale, domain: null, ramp: pick(rng, RAMPS), reverse: chance(rng, 0.2) };
      out.width = round(between(rng, 3, 6), 0.5);
      glow(ctx, out, 0.3, 0);
      break;
    case 'area':
      out.fill = { mode: 'below', colour: out.colour, opacity: round(between(rng, 0.2, 0.5), 0.05) };
      out.y.range = [0, round(between(rng, 250, 450), 10)];
      break;
    case 'ridgeline':
      // The preset steps rows (a year of daily rows per ridge), so it draws every row.
      out.aggregate = { ...out.aggregate, by: 'none' };
      out = ridgelineLine(out, summary, ctx.background);
      out.colour = chance(rng, 0.5) ? ink(ctx) : accent(ctx);
      glow(ctx, out, 0.3, 0, false);
      return { layer: out, fitted: true };
  }
  return { layer: out, fitted: false };
}

function heatmap(layer: HeatmapLayer, ctx: Ctx): HeatmapLayer {
  const { rng, summary } = ctx;
  const out = structuredClone(layer);
  out.valueColumn = valueColumn(ctx, out.valueColumn);
  out.timeColumn = timeColumnFor(ctx, out.timeColumn);
  out.layout = out.timeColumn !== null && chance(rng, 0.7) ? 'calendar' : 'grid';
  out.domain = null;
  out.scale = chance(rng, 0.2) ? 'quantise' : scaleFor(ctx, column(summary, out.valueColumn));
  out.steps = Math.round(between(rng, 4, 9));
  out.ramp = pick(rng, RAMPS);
  out.reverse = chance(rng, 0.2);
  out.missing = chance(rng, 0.3) ? 'colour' : 'transparent';
  out.missingColour = ctx.dark ? '#1c1f26' : '#d9dce2';
  if (ctx.scope === 'all') out.aggregate = pick(rng, ['mean', 'max', 'sum'] as const);
  return out;
}

function text(layer: TextLayer, ctx: Ctx): TextLayer {
  const { rng } = ctx;
  const out = structuredClone(layer);
  out.fontSize = Math.round(between(rng, 32, 96));
  out.colour = chance(rng, 0.5) ? accent(ctx) : ink(ctx);
  out.font = pick(rng, ['terminal', 'sans'] as const);
  out.uppercase = chance(rng, 0.3);
  out.letterSpacing = round(between(rng, 0, 0.15), 0.01);
  out.lineHeight = round(between(rng, 1.1, 1.4), 0.05);
  const outlined = chance(rng, 0.3);
  out.outlineWidth = outlined ? round(between(rng, 1, 3), 0.5) : 0;
  out.outlineColour = ctx.background;
  const [align, anchorY] = pick(rng, [
    ['left', 'top'],
    ['center', 'top'],
    ['left', 'bottom'],
    ['center', 'middle'],
  ] as const);
  out.align = align;
  out.anchorX = align;
  out.anchorY = anchorY;
  glow(ctx, out, 0.25, 0, false);
  return out;
}

function multiples(layer: SmallMultiplesLayer, ctx: Ctx): SmallMultiplesLayer {
  const { rng, summary } = ctx;
  const out = structuredClone(layer);
  if (ctx.scope === 'all' && summary) {
    out.valueColumn = valueColumn(ctx, out.valueColumn);
    const time = timeColumnFor(ctx, null);
    const cats = categoryColumns(summary).filter((c) => (c.categories ?? 0) > 1 && (c.categories ?? 0) <= 60);
    const splits: [SmallMultiplesLayer['splitBy'], string | null][] = [];
    if (time !== null) splits.push(['year', time], ['decade', time]);
    for (const c of cats) splits.push(['category', c.name]);
    if (splits.length === 0) splits.push(['rows', null]);
    const [splitBy, splitColumn] = pick(rng, splits);
    out.splitBy = splitBy;
    out.splitColumn = splitColumn;
  }
  out.domain = null;
  out.chart = pick(rng, ['bars', 'bars', 'dots', 'cells'] as const);
  out.colourByValue = out.chart === 'cells' || chance(rng, 0.6);
  out.scale = scaleFor(ctx, column(summary, out.valueColumn));
  out.ramp = pick(rng, RAMPS);
  out.reverse = chance(rng, 0.2);
  out.colour = chance(rng, 0.6) ? accent(ctx) : ink(ctx);
  out.markSize = out.chart === 'dots' ? round(between(rng, 2, 5), 0.5) : out.chart === 'bars' ? round(between(rng, 0.6, 1), 0.05) : 1;
  out.domainMode = chance(rng, 0.25) ? 'per-panel' : 'shared';
  out.labelPlacement = pick(rng, ['outside', 'top', 'baseline'] as const);
  out.labelColour = ctx.dark ? '#b8bec8' : '#3a3f47';
  out.frame = chance(rng, 0.5);
  glow(ctx, out, 0.25, summary ? visibleRowCount(summary.rowCount, out.rows) : 0, false);
  return out;
}

function hierarchy(layer: HierarchyLayer, ctx: Ctx): HierarchyLayer {
  const { rng, summary } = ctx;
  const out = structuredClone(layer);
  if (ctx.scope === 'all') {
    out.valueColumn = valueColumn(ctx, out.valueColumn);
    out.aggregate = pick(rng, ['sum', 'mean', 'max'] as const);
  }
  out.layout = pick(rng, HIERARCHY_LAYOUTS);
  out.domain = null;
  out.colourBy = out.valueColumn !== null && chance(rng, 0.7) ? 'value' : 'depth';
  out.scale = scaleFor(ctx, column(summary, out.valueColumn));
  out.ramp = pick(rng, RAMPS);
  out.reverse = chance(rng, 0.2);
  out.colour = accent(ctx);
  out.linkWidth = round(between(rng, 2, 4), 0.5);
  out.linkColour = ctx.dark ? '#7a8290' : '#5a606a';
  out.linkOpacity = round(between(rng, 0.4, 0.8), 0.05);
  out.padding = round(between(rng, 0, 3), 0.5);
  out.innerRadius = Math.round(between(rng, 20, 80));
  out.nodeSize = [2, Math.round(between(rng, 8, 16))];
  out.labelColour = ctx.dark ? '#d8dade' : '#26292e';
  glow(ctx, out, 0.3, 0);
  return out;
}

function surface(layer: SurfaceLayer, ctx: Ctx): SurfaceLayer {
  const { rng, summary } = ctx;
  const out = structuredClone(layer);
  out.valueColumn = valueColumn(ctx, out.valueColumn);
  out.timeColumn = timeColumnFor(ctx, out.timeColumn);
  out.layout = out.timeColumn !== null && chance(rng, 0.6) ? 'calendar' : 'grid';
  out.domain = null;
  out.scale = scaleFor(ctx, column(summary, out.valueColumn));
  out.ramp = pick(rng, RAMPS);
  out.reverse = chance(rng, 0.2);
  out.lit = chance(rng, 0.7);
  out.wireframe = chance(rng, 0.3);
  out.wireColour = accent(ctx);
  out.height = [0, Math.round(between(rng, 120, 320))];
  if (ctx.scope === 'all') out.aggregate = pick(rng, ['mean', 'max', 'sum'] as const);
  return out;
}

function reflector(layer: ReflectorLayer, ctx: Ctx): ReflectorLayer {
  const { rng } = ctx;
  const out = structuredClone(layer);
  out.colour = hslHex(between(rng, 0, 360), between(rng, 0.1, 0.4), ctx.dark ? between(rng, 0.03, 0.08) : between(rng, 0.85, 0.95));
  out.reflectivity = round(between(rng, 0.3, 0.8), 0.05);
  out.blur = round(between(rng, 0, 0.5), 0.05);
  out.fade = Math.round(between(rng, 150, 600));
  return out;
}

/** Dark-on-light pairs only: inverted or low-contrast codes scan badly off a projection. */
const QR_PALETTES: readonly [string, string][] = [
  ['#000000', '#ffffff'],
  ['#0b1d3a', '#ffffff'],
  ['#1a1a1a', '#f5f0e6'],
  ['#102a12', '#eef8ee'],
  ['#2a0f2e', '#fbf3ff'],
];

function qr(layer: QrLayer, ctx: Ctx): QrLayer {
  const out = structuredClone(layer);
  const [dark, light] = pick(ctx.rng, QR_PALETTES);
  out.dark = dark;
  out.light = light;
  out.level = pick(ctx.rng, ['M', 'Q'] as const);
  out.margin = 4;
  return out;
}

// ---- entry -----------------------------------------------------------------------------

/**
 * A randomised copy of `layer` (see the module comment), fitted to the output. Data layers
 * need their dataset's summary; without one they come back unchanged.
 */
export function randomiseLayer(
  layer: LayerConfig,
  summary: DatasetSummary | null,
  timeZone: string,
  background: string,
  scope: RandomScope,
  rng: Rng,
): LayerConfig {
  const needsData = layer.type !== 'text' && layer.type !== 'reflector' && layer.type !== 'qr';
  if (needsData && !summary) return structuredClone(layer);
  const ctx: Ctx = { rng, summary, scope, background, dark: luminance(background) < 0.4 };

  // Start every look from plain effects; a recipe switches glow (and blend) on.
  const plain = { ...structuredClone(layer), effects: defaultLayerEffects(), blend: 'normal' as const, opacity: 1 };
  let out: LayerConfig;
  let fitted = false;
  switch (plain.type) {
    case 'instancer':
      out = instancer(plain, ctx);
      break;
    case 'line': {
      const r = line(plain, ctx);
      out = r.layer;
      fitted = r.fitted;
      break;
    }
    case 'heatmap':
      out = heatmap(plain, ctx);
      break;
    case 'text':
      out = text(plain, ctx);
      break;
    case 'multiples':
      out = multiples(plain, ctx);
      break;
    case 'hierarchy':
      out = hierarchy(plain, ctx);
      break;
    case 'surface':
      out = surface(plain, ctx);
      break;
    case 'reflector':
      out = reflector(plain, ctx);
      break;
    case 'qr':
      out = qr(plain, ctx);
      break;
  }

  // What randomising never touches.
  out = { ...out, id: layer.id, name: layer.name, enabled: layer.enabled, datasetId: layer.datasetId, transform: structuredClone(layer.transform), timeline: structuredClone(layer.timeline), screenFixed: layer.screenFixed } as LayerConfig;
  if (!fitted) out = fitAnyLayer(out, summary, timeZone);
  if (out.type === 'multiples') out.labelSize = panelLabelSize(out.panelSize[1]);
  // Bars with no height column are all size[1] long: long enough to read as bars.
  if (out.type === 'instancer' && out.primitive === 'bar' && out.channels.height.column === null) {
    out.size = [out.size[0], Math.round(between(rng, out.arrangement === 'radial' ? 30 : 60, out.arrangement === 'radial' ? 90 : 240)), out.size[2]];
  }

  // Never more instances than the frame budget from this layer alone.
  if ((out.type === 'instancer' || out.type === 'line') && summary) {
    const rows = Math.max(1, visibleRowCount(summary.rowCount, out.rows));
    const maxCount = Math.max(1, Math.floor(FRAME_BUDGET / rows));
    if (out.cloner.count > maxCount) out.cloner = { ...out.cloner, count: maxCount };
  }
  return out;
}
