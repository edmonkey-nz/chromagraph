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

export const InstancerLayerSchema = z.object({
  id: z.string().min(1),
  type: z.literal('instancer'),
  name: z.string(),
  enabled: z.boolean(),
  datasetId: z.string().nullable(),

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
  colour: hexColour,
  opacity: z.number().min(0).max(1),
  blend: z.enum(BLEND_MODES),

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

/** Union of all layer types; more join in later phases. */
export const LayerSchema = z.discriminatedUnion('type', [InstancerLayerSchema]);
export type LayerConfig = z.infer<typeof LayerSchema>;

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
    colour: '#e8e8e8',
    opacity: 1,
    blend: 'normal',
    channels: defaultChannels(),
  };
}
