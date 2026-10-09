import { z } from 'zod';

/**
 * Layer configuration as stored in project.json. Every field here is plain data so it can be
 * patched, saved, and (phase 4) driven by parameters and modulators.
 *
 * Units: positions and sizes are output pixels (1920x1080, y up, origin bottom-left).
 * "t" is the arrangement coordinate of a row: its row index in `index` x mode, or
 * (time - column min) / cadence step in `time` x mode, so gaps in time stay visible.
 */

export const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');
export const vec2 = z.tuple([z.number(), z.number()]);
export const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const SCALE_TYPES = ['linear', 'log', 'sqrt', 'quantise'] as const;
export type ScaleType = (typeof SCALE_TYPES)[number];

/** Continuous ramps (d3-scale-chromatic) plus the categorical palette. */
export const COLOUR_RAMPS = [
  'viridis',
  'magma',
  'inferno',
  'plasma',
  'cividis',
  'turbo',
  'blues',
  'greens',
  'greys',
  'oranges',
  'reds',
  'purples',
  'rdbu',
  'spectral',
] as const;
export type ColourRamp = (typeof COLOUR_RAMPS)[number];

/**
 * In-scene text fonts: 'terminal' (VT323, a 1970s DEC terminal face, fixed width; the default)
 * or 'sans' (troika's default, Roboto). Both resolve to a URL in client/output/fonts.ts.
 */
export const FONTS = ['terminal', 'sans'] as const;
export type FontChoice = (typeof FONTS)[number];

/** How a timeline's playhead runs: 0 -> 1, 1 -> 0, or 0 -> 1 -> 0 (one way per duration). */
export const PLAYBACKS = ['forward', 'reverse', 'pingpong'] as const;
export type Playback = (typeof PLAYBACKS)[number];

export const PRIMITIVES = ['point', 'square', 'bar', 'box', 'sphere'] as const;
export type Primitive = (typeof PRIMITIVES)[number];

export const ARRANGEMENTS = ['linear', 'grid', 'calendar', 'radial', 'spiral'] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export const X_MODES = ['index', 'time'] as const;
export type XMode = (typeof X_MODES)[number];

export const BLEND_MODES = ['normal', 'additive'] as const;

/**
 * Data column -> visual channel. `column: null` means the channel is unmapped and the
 * layer's base value is used. `domain: null` means "auto": the column's min/max (for log,
 * the smallest positive value). Category columns ignore the scale and use their codes.
 */
export const MappingSchema = z.object({
  column: z.string().nullable(),
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  /** Output range in the channel's own unit (see CHANNELS). */
  range: vec2,
  /** Quantise step count (2..64), used only when scale is 'quantise'. */
  steps: z.number().int().min(2).max(64),
  clamp: z.boolean(),
});
export type Mapping = z.infer<typeof MappingSchema>;

export const ColourMappingSchema = z.object({
  column: z.string().nullable(),
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  ramp: z.enum(COLOUR_RAMPS),
  reverse: z.boolean(),
  steps: z.number().int().min(2).max(64),
});
export type ColourMapping = z.infer<typeof ColourMappingSchema>;

/**
 * Numeric channels and the unit of their `range`:
 *   y, z      px offset added to the arranged position
 *   height    px; replaces size[1] (bars grow from their base)
 *   size      multiplier on the whole primitive
 *   rotation  degrees about z
 *   opacity   0..1, multiplied with the layer opacity
 */
export const NUMERIC_CHANNELS = ['y', 'z', 'height', 'size', 'rotation', 'opacity'] as const;
export type NumericChannel = (typeof NUMERIC_CHANNELS)[number];

/** The frame centre in output px: the default pivot for rotating and scaling a layer. */
export const FRAME_CENTRE: [number, number, number] = [960, 540, 0];

/**
 * Whole-layer transform, applied on top of the layer's own layout. The layer is scaled and
 * rotated about `pivot` (px, in the layer's own space), then moved by `position` (px).
 * Rotation is in degrees, applied X then Y then Z (Euler 'XYZ'). Rotations other than about
 * z only show depth with the 3D camera.
 */
export const TransformSchema = z.object({
  position: vec3,
  rotation: vec3,
  scale: vec3,
  pivot: vec3,
});
export type LayerTransform = z.infer<typeof TransformSchema>;

export function identityTransform(): LayerTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [...FRAME_CENTRE] };
}

/**
 * MoGraph-style cloner for the instancer: every data point is drawn `count` times. Clone k
 * (0 = the original) is offset by k x each step:
 *   position  px added to the point's position
 *   rotation  degrees added to the point's own rotation (about its centre, XYZ)
 *   scale     added to 1 per axis (clone k scale = 1 + k * scale, never below 0)
 *   orbit     degrees the clone's position turns about the layer pivot (radial arrays, spirals)
 *   fade      opacity multiplier per clone (clone k opacity x fade^k)
 *   dataStep  rows stepped per clone: clone k keeps row i's arranged position but takes its
 *             mapped values (y, z, height, size, rotation, opacity, colour) from row
 *             i + k * dataStep, so offset clones become a waterfall/ridgeline of later (or
 *             earlier) data; clones that step past the data are not drawn
 * Instances drawn = visible rows x count, so count multiplies the GPU cost.
 */
export const ClonerSchema = z.object({
  count: z.number().int().min(1).max(1000),
  position: vec3,
  rotation: vec3,
  scale: vec3,
  orbit: vec3,
  fade: z.number().min(0).max(1),
  dataStep: z.number().int().min(-100_000).max(100_000),
  /** Colour clones along the ramp by clone index instead of by data. */
  colourByClone: z.boolean(),
});
export type Cloner = z.infer<typeof ClonerSchema>;

export function identityCloner(): Cloner {
  return {
    count: 1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [0, 0, 0],
    orbit: [0, 0, 0],
    fade: 1,
    dataStep: 0,
    colourByClone: false,
  };
}

/**
 * The layer's own output effects, applied to its image before the keystone warp:
 *   glow    bloom around the layer's bright marks (threshold = luminance where glow is full,
 *           0..1, with a 0.05 soft knee below it, so 1 still lets pure white glow)
 *   trails  motion trails: each frame keeps `persistence` of the previous one (0 = off,
 *           0.95 = long smears). Frame-rate independent: persistence is per 1/60 s.
 * The output groups layers with identical settings (see shared/effects-plan.ts).
 */
export const LayerEffectsSchema = z.object({
  glow: z.object({
    enabled: z.boolean(),
    strength: z.number().min(0).max(3),
    radius: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
  }),
  trails: z.object({
    enabled: z.boolean(),
    persistence: z.number().min(0).max(0.99),
  }),
  /**
   * Drop shadow drawn just beneath this layer (over the layers below it): the layer's shape,
   * blurred by `spread` px, tinted `colour` at `opacity`, moved by `offset` px (x right, y up).
   * Screen space, like a CSS drop shadow, also with the 3D camera.
   */
  shadow: z.object({
    enabled: z.boolean(),
    colour: hexColour,
    opacity: z.number().min(0).max(1),
    spread: z.number().min(0).max(100),
    offset: vec2,
  }),
  /** The layer drawn blurred by `amount` px (screen space), in its own place in the stack. */
  blur: z.object({
    enabled: z.boolean(),
    amount: z.number().min(0).max(100),
  }),
});
export type LayerEffects = z.infer<typeof LayerEffectsSchema>;

export function defaultLayerEffects(): LayerEffects {
  return {
    glow: { enabled: false, strength: 0.8, radius: 0.4, threshold: 0.2 },
    trails: { enabled: false, persistence: 0.85 },
    shadow: { enabled: false, colour: '#000000', opacity: 0.6, spread: 8, offset: [6, -6] },
    blur: { enabled: false, amount: 4 },
  };
}

/**
 * The layer's timeline. Off (`own: false`) the layer's ramps, keyframes and data playhead
 * follow the project timeline; on, they follow this duration and loop, played by the
 * layer's own transport (session.layerTransports[layerId]).
 */
export const LayerTimelineSchema = z.object({
  own: z.boolean(),
  /** Seconds for one full pass of the layer's playhead. */
  duration: z.number().positive(),
  loop: z.boolean(),
  playback: z.enum(PLAYBACKS),
});
export type LayerTimeline = z.infer<typeof LayerTimelineSchema>;

export function defaultLayerTimeline(): LayerTimeline {
  return { own: false, duration: 600, loop: true, playback: 'forward' };
}

/** Fields every layer type has. */
export const LayerBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  datasetId: z.string().nullable(),
  opacity: z.number().min(0).max(1),
  blend: z.enum(BLEND_MODES),
  transform: TransformSchema,
  effects: LayerEffectsSchema,
  timeline: LayerTimelineSchema,
  /**
   * Fixed to the screen: the layer is drawn with the 2D pixel camera (x 0..1920, y 0..1080)
   * whatever the project camera does, so it ignores 3D camera moves (titles, overlays).
   */
  screenFixed: z.boolean(),
});
export type LayerBase = z.infer<typeof LayerBaseSchema>;

export const LABEL_EVERY = ['year', 'decade', 'rows'] as const;
export const LABEL_TEXTS = ['date', 'value'] as const;
export const LABEL_ORIENTATIONS = ['along', 'outward', 'upright'] as const;

/**
 * Text labels at points of an instancer's own arrangement (so they follow a spiral, ring,
 * line or calendar exactly, including the layer's transform and visible row range):
 *   every        'year' / 'decade': the first row of each calendar year or decade (needs a
 *                time column), labelled "1879" / "1870s"; 'rows': every `rows`-th row,
 *                labelled with its date (`text: 'date'`) or `column`'s value
 *   offset       px from the point: outward for radial/spiral, up for linear, left for
 *                grid/calendar
 *   orientation  'along' the arrangement (tangent), 'outward' (radial/spiral: along the
 *                radius), or 'upright'; text is flipped so it never reads upside down
 * Labels belong to the original points only (not cloner copies) and ignore the y/z
 * channels. `hidePoints` draws the labels alone (for a labels-only copy of a layer). At most 500 are drawn: beyond that, every k-th label is shown.
 */
export const InstancerLabelsSchema = z.object({
  enabled: z.boolean(),
  every: z.enum(LABEL_EVERY),
  rows: z.number().int().min(1),
  text: z.enum(LABEL_TEXTS),
  column: z.string().nullable(),
  /** px at 1080p (projection minimum is 24). */
  size: z.number().min(6).max(200),
  offset: z.number(),
  orientation: z.enum(LABEL_ORIENTATIONS),
  colour: hexColour,
  /** Draw only the labels, not the points (a labels-only copy of a layer). */
  hidePoints: z.boolean(),
  font: z.enum(FONTS),
  uppercase: z.boolean(),
});
export type InstancerLabels = z.infer<typeof InstancerLabelsSchema>;

export function defaultInstancerLabels(): InstancerLabels {
  return { enabled: false, every: 'year', rows: 365, text: 'date', column: null, size: 24, offset: 16, orientation: 'along', colour: '#e8e8e8', hidePoints: false, font: 'terminal', uppercase: false };
}

export function defaultEdges(): { enabled: boolean; colour: string; width: number; faceOpacity: number; glow: number } {
  return { enabled: false, colour: '#ff3030', width: 2, faceOpacity: 1, glow: 0 };
}

export const InstancerLayerSchema = LayerBaseSchema.extend({
  type: z.literal('instancer'),

  primitive: z.enum(PRIMITIVES),
  xMode: z.enum(X_MODES),
  /** Time column used for `time` x mode and the calendar arrangement. */
  timeColumn: z.string().nullable(),
  /** Visible row range as fractions of the row count, [start, end], 0..1. */
  rows: vec2,
  /** When true, t is measured from the first visible row, so the range scrolls into place. */
  followRange: z.boolean(),

  /**
   * Where each row goes, from its t (positions in px, y up):
   *   linear    origin + t * step
   *   grid      col = t mod gridColumns, row = floor(t / gridColumns);
   *             (origin.x + col * cell.w, origin.y - row * cell.h)
   *   calendar  needs a time column; day of year (0-based, dataset timezone) and year index
   *             from the first year: (origin.x + day * cell.w, origin.y - yearIndex * cell.h)
   *   radial    angle = t * angleStep (degrees, clockwise from 12 o'clock), r = radius
   *   spiral    as radial with r = radius + t * radiusStep
   * Grid and calendar fill downward from origin, so origin is their top-left cell.
   */
  arrangement: z.enum(ARRANGEMENTS),
  /** px. Linear: position at t = 0. Grid/calendar: top-left cell. Radial/spiral: centre. */
  origin: vec3,
  /** Linear: px per unit of t. */
  step: vec3,
  /** Grid: cells per row. */
  gridColumns: z.number().int().min(1),
  /** Grid and calendar: cell width and height in px. */
  cell: vec2,
  /** Radial/spiral: start radius px, degrees per unit of t, px of radius per unit of t. */
  radius: z.number(),
  angleStep: z.number(),
  radiusStep: z.number(),

  /** Base primitive size in px: width, height, depth. */
  size: vec3,
  /**
   * Which axis the primitive's height (size[1] or the height channel) runs along: 'y' (up the
   * frame) or 'z' (out of the frame, for 3D bars standing on a grid or calendar).
   */
  heightAxis: z.enum(['y', 'z']).default('y'),
  colour: hexColour,
  cloner: ClonerSchema,
  labels: InstancerLabelsSchema,
  /**
   * Edge style for the 3D `box` primitive (ignored by other primitives): edges drawn in
   * `colour`, `width` px wide on screen, faces at `faceOpacity` (0 = edges only), and `glow`
   * 0..1 brightening the edges (pair it with the layer's glow for neon).
   */
  edges: z.object({
    enabled: z.boolean(),
    colour: hexColour,
    width: z.number().min(0.5).max(20),
    faceOpacity: z.number().min(0).max(1),
    glow: z.number().min(0).max(1),
  }),

  channels: z.object({
    y: MappingSchema,
    z: MappingSchema,
    height: MappingSchema,
    size: MappingSchema,
    rotation: MappingSchema,
    opacity: MappingSchema,
    colour: ColourMappingSchema,
  }),
});
export type InstancerLayer = z.infer<typeof InstancerLayerSchema>;

/**
 * Line through the rows in order, as real screen-space geometry (`width` px, never GL
 * 1 px lines). Each row's point is origin + t * step (t as for the instancer), plus the
 * mapped y and z offsets.
 */
export const AGGREGATES = ['mean', 'sum', 'min', 'max', 'last'] as const;
export const LINE_BUCKETS = ['none', 'week', 'month', 'year', 'rows'] as const;

export const LineLayerSchema = LayerBaseSchema.extend({
  type: z.literal('line'),
  xMode: z.enum(X_MODES),
  timeColumn: z.string().nullable(),
  rows: vec2,
  followRange: z.boolean(),
  origin: vec3,
  step: vec3,
  /** Value column -> y offset in px. Unmapped draws a flat line. */
  y: MappingSchema,
  z: MappingSchema,
  /** Screen-space width in px (projection minimum is 2). */
  width: z.number().min(1).max(200),
  colour: hexColour,
  /** Optional colour by value along the line (overrides `colour` where mapped). */
  colourMap: ColourMappingSchema,
  /**
   * Break the line at missing values and, in time mode, across time gaps longer than
   * gapFactor x the cadence step. Off joins across them (an explicit choice, never a default
   * that hides gaps).
   */
  breakOnGaps: z.boolean(),
  gapFactor: z.number().min(1),
  /**
   * Cloner as for the instancer, applied to the whole line: clone k is offset by k x
   * position, orbits the pivot by k x orbit, fades by fade^k and takes its values from
   * row i + k * dataStep (ridgelines). Per-clone rotation and scale are ignored for lines.
   */
  cloner: ClonerSchema,
  /**
   * Area fill between the line and its baseline (the line's own origin.y plus the clone's
   * offset). With an opaque fill in the background colour, nearer clones hide the ones
   * behind them (Joy Division style ridgelines).
   */
  fill: z.object({
    mode: z.enum(['none', 'below']),
    colour: hexColour,
    opacity: z.number().min(0).max(1),
  }),
  /**
   * Aggregation: one point per bucket instead of per row, so dense spiky data (daily rain)
   * reads as a line chart. Buckets are calendar weeks, months or years (in the dataset
   * timezone; needs a time column) or runs of `rows` rows; `fn` combines a bucket's values
   * (missing values are left out; a bucket with none is missing, so the line breaks there).
   * The point sits at the middle of its bucket's time span. Rows, the data playhead and the
   * cloner's data step then count buckets. 'none' draws every row.
   */
  aggregate: z.object({
    by: z.enum(LINE_BUCKETS),
    rows: z.number().int().min(1),
    fn: z.enum(AGGREGATES),
  }),
});
export type LineLayer = z.infer<typeof LineLayerSchema>;

export const HEATMAP_LAYOUTS = ['calendar', 'grid'] as const;

/**
 * Heat map drawn from a data texture (one texel per cell), so even 100k cells is one quad.
 *   calendar  rows = years (first at the top), columns = day of year, in the dataset timezone
 *   grid      cells in row order, gridColumns per line
 * Cells with no data are transparent or `missingColour`; they are never filled in.
 */
export const HeatmapLayerSchema = LayerBaseSchema.extend({
  type: z.literal('heatmap'),
  layout: z.enum(HEATMAP_LAYOUTS),
  timeColumn: z.string().nullable(),
  valueColumn: z.string().nullable(),
  rows: vec2,
  gridColumns: z.number().int().min(1),
  /** Top-left corner of the map in px (y up, so the map extends downward from here). */
  origin: vec3,
  /** Cell width and height in px. */
  cell: vec2,
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  ramp: z.enum(COLOUR_RAMPS),
  reverse: z.boolean(),
  steps: z.number().int().min(2).max(64),
  /** Calendar only: how several rows on the same day combine (an explicit choice). */
  aggregate: z.enum(AGGREGATES),
  missing: z.enum(['transparent', 'colour']),
  missingColour: hexColour,
});
export type HeatmapLayer = z.infer<typeof HeatmapLayerSchema>;

/**
 * Text overlay (troika-three-text, SDF). `text` is a template: {Column name} is replaced with
 * that column's value at the current row, {Column name|format} formats it (see
 * text-template.ts). The current row is `row` (0..1 of the row count), so a ramp
 * modulator on it follows the data playhead. Without a dataset only static text shows.
 */
export const TextLayerSchema = LayerBaseSchema.extend({
  type: z.literal('text'),
  text: z.string().max(2000),
  row: z.number().min(0).max(1),
  /** Anchor point in px. */
  position: vec3,
  /** px at 1080p (projection minimum is 24). */
  fontSize: z.number().min(8).max(400),
  colour: hexColour,
  align: z.enum(['left', 'center', 'right']),
  anchorX: z.enum(['left', 'center', 'right']),
  anchorY: z.enum(['top', 'middle', 'bottom']),
  /** Wrap width in px; 0 means no wrapping. */
  maxWidth: z.number().min(0),
  lineHeight: z.number().min(0.5).max(3),
  letterSpacing: z.number().min(-0.5).max(2),
  outlineWidth: z.number().min(0).max(20),
  outlineColour: hexColour,
  /** 'terminal' or 'sans' (see FONTS), or the URL of a .ttf/.otf/.woff font served by the app. */
  font: z.string().min(1),
  /** Show the text in capitals (the template is kept as written). */
  uppercase: z.boolean(),
});
export type TextLayer = z.infer<typeof TextLayerSchema>;

/** How rows are split into panels for small multiples. */
export const SPLITS = ['year', 'month', 'decade', 'category', 'rows'] as const;
export const MULTIPLES_LABEL_PLACEMENTS = ['outside', 'top', 'baseline'] as const;

/**
 * Small multiples: the rows are split into panels (one per year, month, decade, category
 * value or fixed row chunk) laid out on a grid, each panel a mini chart of `valueColumn`.
 * Everything is one instanced draw.
 *
 * Inside a panel, x is the row's position within the panel's period: day of year for
 * `year`, day of month for `month`, year within the decade (with day fraction) for
 * `decade`, otherwise the row's index within the panel. Gaps therefore stay visible.
 * y is the scaled value (bars grow from the panel's baseline).
 */
export const SmallMultiplesLayerSchema = LayerBaseSchema.extend({
  type: z.literal('multiples'),
  splitBy: z.enum(SPLITS),
  /** Time column for year/month/decade splits; category column for `category`. */
  splitColumn: z.string().nullable(),
  /** Rows per panel for `rows`. */
  chunkRows: z.number().int().min(1),
  valueColumn: z.string().nullable(),
  rows: vec2,
  chart: z.enum(['bars', 'dots', 'cells']),
  /** Panels per line of the grid. */
  columns: z.number().int().min(1),
  /** Top-left corner of the first panel, px (y up; panels fill downward). */
  origin: vec3,
  /** Panel width and height px, and the gap between panels px. */
  panelSize: vec2,
  gap: vec2,
  /** Value scale: domain shared by all panels, or each panel scaled to its own range. */
  domainMode: z.enum(['shared', 'per-panel']),
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  /** Quantise step count (2..64), used only when scale is 'quantise'. */
  steps: z.number().int().min(2).max(64).default(5),
  colour: hexColour,
  /** Colour by value along a ramp (otherwise `colour`). */
  colourByValue: z.boolean(),
  ramp: z.enum(COLOUR_RAMPS),
  reverse: z.boolean(),
  /** Bar/dot size as a fraction of the per-row x step (bars) or px (dots). */
  markSize: z.number().min(0.05).max(50),
  /** Panel titles (e.g. "1923", "Mar 1923", the category) at this px size; 0 hides them. */
  labelSize: z.number().min(0).max(200),
  labelColour: hexColour,
  labelFont: z.enum(FONTS),
  labelUppercase: z.boolean(),
  /**
   * Panel titles: 'outside' above the panel's frame (the original look), 'top' inside its top
   * edge, or 'baseline' inside, along the bottom (the bars' baseline).
   */
  labelPlacement: z.enum(MULTIPLES_LABEL_PLACEMENTS),
  /** Faint frame around each panel. */
  frame: z.boolean(),
});
export type SmallMultiplesLayer = z.infer<typeof SmallMultiplesLayerSchema>;

export const HIERARCHY_LAYOUTS = ['dendrogram', 'radial-dendrogram', 'tree', 'sunburst', 'icicle', 'pack', 'treemap'] as const;
export const HIERARCHY_TIME_UNITS = ['decade', 'year', 'month', 'day'] as const;

/** One level of the hierarchy: group by a calendar unit of a time column, or by a category column. */
export const HierarchyLevelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), column: z.string(), unit: z.enum(HIERARCHY_TIME_UNITS) }),
  z.object({ kind: z.literal('category'), column: z.string() }),
]);
export type HierarchyLevel = z.infer<typeof HierarchyLevelSchema>;

/**
 * Hierarchy (d3-hierarchy): rows are grouped level by level (e.g. decade -> year -> month)
 * into a tree; leaves aggregate `valueColumn` with `aggregate` (an explicit choice), and
 * parents sum or take the extreme of their children per `aggregate`. Rows with a missing
 * value are left out of the totals and counted (reported, never filled in).
 *
 * Layouts: dendrogram (d3.cluster), tree (d3.tree), radial variants of the dendrogram,
 * sunburst and icicle (d3.partition), pack (circle packing) and treemap. Layout runs off the
 * output's main thread. Nodes are instanced (size/colour by value), links are screen-space
 * segments `linkWidth` px wide.
 */
export const HierarchyLayerSchema = LayerBaseSchema.extend({
  type: z.literal('hierarchy'),
  levels: z.array(HierarchyLevelSchema).min(1).max(5),
  valueColumn: z.string().nullable(),
  aggregate: z.enum(AGGREGATES),
  rows: vec2,
  layout: z.enum(HIERARCHY_LAYOUTS),
  /** Bounding box: top-left corner and size, px (radial layouts use the box's centre and min half-size). */
  origin: vec3,
  size: vec2,
  /** Radial layouts: inner radius px (leaves the centre clear). */
  innerRadius: z.number().min(0),
  /** Node marker size range px (by value); [r, r] for uniform. Unused by area layouts. */
  nodeSize: vec2,
  colourBy: z.enum(['value', 'depth', 'none']),
  colour: hexColour,
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  /** Quantise step count (2..64), used only when scale is 'quantise'. */
  steps: z.number().int().min(2).max(64).default(5),
  ramp: z.enum(COLOUR_RAMPS),
  reverse: z.boolean(),
  linkWidth: z.number().min(0).max(20),
  linkColour: hexColour,
  linkOpacity: z.number().min(0).max(1),
  /** Area layouts (sunburst, icicle, pack, treemap): gap between cells px. */
  padding: z.number().min(0).max(40),
  /** Label nodes down to this depth (0 = root only, -1 = none) at labelSize px. */
  labelDepth: z.number().int().min(-1).max(5),
  labelSize: z.number().min(8).max(200),
  labelColour: hexColour,
  labelFont: z.enum(FONTS),
  labelUppercase: z.boolean(),
});
export type HierarchyLayer = z.infer<typeof HierarchyLayerSchema>;

/**
 * 3D surface: values on a grid (calendar year x day, or rows wrapped `gridColumns` per line)
 * as a height field. The grid lies in the x/y plane like the heat map (top-left at `origin`,
 * `cell` px per cell) and heights rise along +z, so tilt the 3D camera to see relief.
 * Cells with no data are holes in the surface; they are never interpolated over.
 */
export const SurfaceLayerSchema = LayerBaseSchema.extend({
  type: z.literal('surface'),
  layout: z.enum(HEATMAP_LAYOUTS),
  timeColumn: z.string().nullable(),
  valueColumn: z.string().nullable(),
  rows: vec2,
  gridColumns: z.number().int().min(1),
  aggregate: z.enum(AGGREGATES),
  origin: vec3,
  cell: vec2,
  /** Height range px for the scaled value. */
  height: vec2,
  scale: z.enum(SCALE_TYPES),
  domain: vec2.nullable(),
  /** Quantise step count (2..64), used only when scale is 'quantise'. */
  steps: z.number().int().min(2).max(64).default(5),
  ramp: z.enum(COLOUR_RAMPS),
  reverse: z.boolean(),
  /** Shade with a fixed light (needs normals); off draws flat ramp colours. */
  lit: z.boolean(),
  wireframe: z.boolean(),
  wireColour: hexColour,
});
export type SurfaceLayer = z.infer<typeof SurfaceLayerSchema>;

export const LAYER_TYPES = ['instancer', 'line', 'heatmap', 'text', 'multiples', 'hierarchy', 'surface'] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

/** Union of all layer types. */
export const LayerSchema = z.discriminatedUnion('type', [
  InstancerLayerSchema,
  LineLayerSchema,
  HeatmapLayerSchema,
  TextLayerSchema,
  SmallMultiplesLayerSchema,
  HierarchyLayerSchema,
  SurfaceLayerSchema,
]);
export type LayerConfig = z.infer<typeof LayerSchema>;

export function isInstancer(l: LayerConfig): l is InstancerLayer {
  return l.type === 'instancer';
}

export function unmapped(range: [number, number]): Mapping {
  return { column: null, scale: 'linear', domain: null, range, steps: 5, clamp: true };
}

export function defaultChannels(): InstancerLayer['channels'] {
  return {
    y: unmapped([0, 300]),
    z: unmapped([0, 300]),
    height: unmapped([2, 300]),
    size: unmapped([0.5, 2]),
    rotation: unmapped([0, 360]),
    opacity: unmapped([0.1, 1]),
    colour: { column: null, scale: 'linear', domain: null, ramp: 'viridis', reverse: false, steps: 5 },
  };
}

/** A complete instancer layer with neutral settings; callers fill in dataset and layout. */
export function blankInstancerLayer(id: string, name: string, datasetId: string | null): InstancerLayer {
  return {
    id,
    type: 'instancer',
    name,
    enabled: true,
    datasetId,
    primitive: 'bar',
    xMode: 'index',
    timeColumn: null,
    rows: [0, 1],
    followRange: false,
    arrangement: 'linear',
    origin: [60, 140, 0],
    step: [4, 0, 0],
    gridColumns: 100,
    cell: [6, 6],
    radius: 100,
    angleStep: 1,
    radiusStep: 0.01,
    size: [3, 3, 3],
    heightAxis: 'y',
    colour: '#e8e8e8',
    opacity: 1,
    blend: 'normal',
    transform: identityTransform(),
    effects: defaultLayerEffects(),
    timeline: defaultLayerTimeline(),
    screenFixed: false,
    cloner: identityCloner(),
    labels: defaultInstancerLabels(),
    edges: defaultEdges(),
    channels: defaultChannels(),
  };
}

function base(id: string, name: string, datasetId: string | null): LayerBase {
  return { id, name, enabled: true, datasetId, opacity: 1, blend: 'normal', transform: identityTransform(), effects: defaultLayerEffects(), timeline: defaultLayerTimeline(), screenFixed: false };
}

export function blankLineLayer(id: string, name: string, datasetId: string | null): LineLayer {
  return {
    ...base(id, name, datasetId),
    type: 'line',
    xMode: 'index',
    timeColumn: null,
    rows: [0, 1],
    followRange: false,
    origin: [60, 540, 0],
    step: [1, 0, 0],
    y: unmapped([-300, 300]),
    z: unmapped([0, 300]),
    width: 2,
    colour: '#e8e8e8',
    colourMap: { column: null, scale: 'linear', domain: null, ramp: 'viridis', reverse: false, steps: 5 },
    breakOnGaps: true,
    gapFactor: 1.5,
    cloner: identityCloner(),
    fill: { mode: 'none', colour: '#000000', opacity: 1 },
    aggregate: { by: 'none', rows: 30, fn: 'mean' },
  };
}

export function blankHeatmapLayer(id: string, name: string, datasetId: string | null): HeatmapLayer {
  return {
    ...base(id, name, datasetId),
    type: 'heatmap',
    layout: 'grid',
    timeColumn: null,
    valueColumn: null,
    rows: [0, 1],
    gridColumns: 100,
    origin: [60, 1020, 0],
    cell: [6, 6],
    scale: 'linear',
    domain: null,
    ramp: 'viridis',
    reverse: false,
    steps: 5,
    aggregate: 'mean',
    missing: 'transparent',
    missingColour: '#202020',
  };
}

export function blankTextLayer(id: string, name: string, datasetId: string | null): TextLayer {
  return {
    ...base(id, name, datasetId),
    type: 'text',
    text: 'data-wrangler',
    row: 0,
    position: [60, 1020, 0],
    fontSize: 48,
    colour: '#ffffff',
    align: 'left',
    anchorX: 'left',
    anchorY: 'top',
    maxWidth: 0,
    lineHeight: 1.2,
    letterSpacing: 0,
    outlineWidth: 0,
    outlineColour: '#000000',
    font: 'terminal',
    uppercase: false,
  };
}

export function blankMultiplesLayer(id: string, name: string, datasetId: string | null): SmallMultiplesLayer {
  return {
    ...base(id, name, datasetId),
    type: 'multiples',
    splitBy: 'year',
    splitColumn: null,
    chunkRows: 365,
    valueColumn: null,
    rows: [0, 1],
    chart: 'bars',
    columns: 12,
    origin: [60, 1020, 0],
    panelSize: [140, 70],
    gap: [10, 10],
    domainMode: 'shared',
    scale: 'linear',
    domain: null,
    steps: 5,
    colour: '#e8e8e8',
    colourByValue: false,
    ramp: 'viridis',
    reverse: false,
    markSize: 1,
    labelSize: 0,
    labelColour: '#9aa0a6',
    labelFont: 'terminal',
    labelUppercase: false,
    labelPlacement: 'outside',
    frame: false,
  };
}

export function blankHierarchyLayer(id: string, name: string, datasetId: string | null): HierarchyLayer {
  return {
    ...base(id, name, datasetId),
    type: 'hierarchy',
    levels: [{ kind: 'time', column: '', unit: 'decade' }],
    valueColumn: null,
    aggregate: 'sum',
    rows: [0, 1],
    layout: 'dendrogram',
    origin: [60, 1020, 0],
    size: [1800, 960],
    innerRadius: 40,
    nodeSize: [2, 12],
    colourBy: 'value',
    colour: '#e8e8e8',
    scale: 'sqrt',
    domain: null,
    steps: 5,
    ramp: 'viridis',
    reverse: false,
    linkWidth: 2,
    linkColour: '#6b7280',
    linkOpacity: 0.6,
    padding: 1,
    labelDepth: 1,
    labelSize: 24,
    labelColour: '#d8dade',
    labelFont: 'terminal',
    labelUppercase: false,
  };
}

export function blankSurfaceLayer(id: string, name: string, datasetId: string | null): SurfaceLayer {
  return {
    ...base(id, name, datasetId),
    type: 'surface',
    layout: 'grid',
    timeColumn: null,
    valueColumn: null,
    rows: [0, 1],
    gridColumns: 100,
    aggregate: 'mean',
    origin: [60, 1020, 0],
    cell: [6, 6],
    height: [0, 200],
    scale: 'linear',
    domain: null,
    steps: 5,
    ramp: 'viridis',
    reverse: false,
    lit: true,
    wireframe: false,
    wireColour: '#ffffff',
  };
}
