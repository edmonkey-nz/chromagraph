import { z } from 'zod';
import { defaultAxes, defaultChannels, defaultDensityDots, defaultLineSplit, hexColour, identityCloner, identityTransform, LayerSchema, PLAYBACKS, vec3 } from './layer-schema.ts';
import { ClockSchema, ParameterSchema, TransportSchema, WALL_CLOCK, type Clock, type Transport } from './modulators.ts';
import type { OutputProfile } from './output-profile.ts';

export { LayerSchema, type LayerConfig } from './layer-schema.ts';

/**
 * project.json schema. Bump CURRENT_VERSION and add an entry to `migrations` whenever the
 * persisted shape changes. Migrations are pure functions from version N to N + 1.
 */
export const CURRENT_VERSION = 27;


export const DatasetSchema = z.object({
  id: z.string().min(1),
  /** File name inside the project's data/ folder. */
  file: z.string().min(1),
  label: z.string(),
  /** Display timezone. Timestamps are always held in UTC. */
  timeZone: z.string().min(1),
  /**
   * Credits, typed by the user ('' when unknown). Text layers show them with {@source},
   * {@url} and {@attribution} (shared/text-template.ts); a QR layer can encode `url`.
   *   source       where the data comes from ("NIWA CliFlo")
   *   url          a link to it (shown as typed; not checked)
   *   attribution  the credit or licence line the source asks for ("© NIWA, CC BY 4.0")
   */
  source: z.string().max(500),
  url: z.string().max(2000),
  attribution: z.string().max(500),
  /**
   * Treat as missing (schema v24): cell texts that mean "no value" in this file, such as "NA",
   * "-" or "..", matched exactly after trimming. Such cells parse as missing (NaN / null), so one
   * "NA" no longer turns a number column into text. Empty cells are always missing. The parse
   * report counts what each marker blanked; the file itself is never changed.
   */
  missing: z.array(z.string().min(1).max(40)).max(20),
});

/**
 * 2D: orthographic camera in output pixels. 3D: perspective camera orbiting a target; at
 * yaw = pitch = 0 and distance = 1 the z = 0 plane fills the frame exactly, so a 2D layout
 * looks the same in both modes until the camera moves.
 */
/**
 * Depth of field (3D camera only): what is `depth` px deep around the focus plane stays sharp;
 * beyond it the blur grows over another `depth` px (at least 50) to `amount` px at 1080p.
 * `focus` moves the focus plane from the camera's target, + further away (px).
 */
export const DofSchema = z.object({
  enabled: z.boolean(),
  focus: z.number().min(-20_000).max(20_000),
  depth: z.number().min(0).max(20_000),
  amount: z.number().min(0).max(40),
});
export type Dof = z.infer<typeof DofSchema>;

export function defaultDof(): Dof {
  return { enabled: false, focus: 0, depth: 200, amount: 12 };
}

/**
 * Follow camera (schema v22): the 3D camera's look-at point rides on the newest visible point of
 * a line layer (its last visible point, after the layer transform), so the line runs ahead of the
 * camera as it plots, like a road. Yaw, pitch and distance still set where the eye sits relative
 * to that point (Road view: behind it, low and close).
 *   smoothing  seconds to catch up about two thirds of the way (0: locked on)
 *   height     0..1: how much the look-at point rises and falls with the line (0: stays at the
 *              camera target's height, a flat road; 1: follows every bump)
 *   lead       px ahead of the point along x, so the newest point sits a little behind centre
 *   loop       (schema v23) when the line starts again (its newest point jumps back, as a looping
 *              reveal restarts), fly back over `loopSeconds` instead of snapping: the eye circles
 *              the point `loopTurns` times, rising and pulling out midway, and lands on the line
 */
export const CameraFollowSchema = z.object({
  enabled: z.boolean(),
  layerId: z.string().nullable(),
  smoothing: z.number().min(0).max(10),
  height: z.number().min(0).max(1),
  lead: z.number().min(-4000).max(4000),
  loop: z.boolean(),
  loopSeconds: z.number().min(1).max(60),
  loopTurns: z.number().int().min(0).max(4),
});
export type CameraFollow = z.infer<typeof CameraFollowSchema>;

export function defaultCameraFollow(): CameraFollow {
  return { enabled: false, layerId: null, smoothing: 0.6, height: 0.5, lead: 0, loop: true, loopSeconds: 6, loopTurns: 1 };
}

export const CameraSchema = z.object({
  mode: z.enum(['2d', '3d']),
  /** Vertical field of view, degrees (3D). */
  fov: z.number().min(5).max(120),
  /** Degrees. Yaw turns about the vertical axis, pitch tilts up/down. */
  yaw: z.number(),
  pitch: z.number().min(-89).max(89),
  /** Multiple of the frame-filling distance. */
  distance: z.number().positive(),
  /** Look-at point as an offset in px from the frame centre. */
  target: vec3,
  /**
   * 3D projection: 'perspective', or 'isometric' (orthographic, so parallel edges stay
   * parallel; with yaw 45 and pitch 35.26 it is the classic isometric view). `distance` then
   * scales the view instead of moving the camera.
   */
  projection: z.enum(['perspective', 'isometric']),
  dof: DofSchema,
  follow: CameraFollowSchema,
});
export type Camera = z.infer<typeof CameraSchema>;
/** The camera as the stage, orbit editing and morphs see it: everything but follow (applied on top). */
export type OrbitCamera = Omit<Camera, 'follow'>;


export const EASINGS_MORPH = ['linear', 'smooth', 'ease-in', 'ease-out'] as const;

export const TransitionSchema = z.object({
  /** Seconds, 0.1..10. */
  duration: z.number().min(0.1).max(10),
  easing: z.enum(EASINGS_MORPH),
});

export function defaultTransition(): z.infer<typeof TransitionSchema> {
  return { duration: 2, easing: 'smooth' };
}

export const SceneSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  layers: z.array(LayerSchema),
  camera: CameraSchema,
  output: z.object({ background: hexColour }),
  parameters: z.record(z.string(), ParameterSchema),
  /** Optional per-scene transition (overrides project.transition when going to this scene). */
  transition: TransitionSchema.nullable(),
});

export const ProjectSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  name: z.string(),
  datasets: z.array(DatasetSchema),
  layers: z.array(LayerSchema),
  /** Modulators by parameter id (see parameters.ts). Base values live in the fields themselves. */
  parameters: z.record(z.string(), ParameterSchema),
  timeline: z.object({
    /** Seconds for one full pass of the playhead (one way, for ping-pong). */
    duration: z.number().positive(),
    loop: z.boolean(),
    playback: z.enum(PLAYBACKS),
    /**
     * Softening the jump where the timeline restarts: the whole output fades in from the
     * background over `fadeLength` s at the start (`fadeIn`) and out to it before the end
     * (`fadeOut`), and `gap` s of background are held between one pass and the next.
     */
    fadeIn: z.boolean(),
    fadeOut: z.boolean(),
    fadeLength: z.number().min(0.1).max(10),
    gap: z.number().min(0).max(5),
  }),
  camera: CameraSchema,
  output: z.object({
    background: hexColour,
  }),
  /**
   * Scenes: named looks (layers, camera, output and modulators) captured from the project.
   * Going to a scene copies it into the project and starts a morph (see session.morph).
   * Datasets and the timeline are shared by all scenes.
   */
  scenes: z.array(SceneSchema).default([]),
  /** Default transition used when going to a scene. */
  transition: TransitionSchema.default(defaultTransition),
});

export type Dataset = z.infer<typeof DatasetSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export function defaultProject(name: string): Project {
  return {
    version: CURRENT_VERSION,
    name,
    datasets: [],
    layers: [],
    parameters: {},
    timeline: { duration: 600, loop: true, playback: 'forward', fadeIn: false, fadeOut: false, fadeLength: 1, gap: 0 },
    camera: defaultCamera(),
    output: { background: '#000000' },
    scenes: [],
    transition: defaultTransition(),
  };
}

export function defaultCamera(): Camera {
  return { mode: '2d', fov: 45, yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0], projection: 'perspective', dof: defaultDof(), follow: defaultCameraFollow() };
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;
type Doc = Record<string, unknown>;

/** v5/v6 whole-output effects, as migrations 4 and 6 see them. */
const V5_EFFECTS = {
  bloom: { enabled: false, strength: 0.8, radius: 0.4, threshold: 0.2 },
  trails: { enabled: false, persistence: 0.85 },
};

/** v5/v6 output-effect parameter ids and where each moves on a layer in v7. */
const V7_PARAM_MOVES: [string, string, 'glow' | 'trails'][] = [
  ['output.effects.bloom.strength', 'effects.glow.strength', 'glow'],
  ['output.effects.bloom.radius', 'effects.glow.radius', 'glow'],
  ['output.effects.bloom.threshold', 'effects.glow.threshold', 'glow'],
  ['output.effects.trails.persistence', 'effects.trails.persistence', 'trails'],
];

/**
 * v6 -> v7 for one look (the project, or a scene): the whole-output glow and trails become
 * each layer's own settings, on where both the output effect and the layer's v6 flag were on,
 * so it looks the same. Modulators on the output settings move to those layers.
 */
function perLayerEffects(look: Doc): Doc {
  const output = (look.output ?? {}) as Doc;
  const fx = (output.effects ?? V5_EFFECTS) as typeof V5_EFFECTS;
  const layers = Array.isArray(look.layers) ? (look.layers as Doc[]) : [];
  const parameters = { ...((look.parameters ?? {}) as Doc) };
  const on = { glow: [] as string[], trails: [] as string[] };
  const next = layers.map((l) => {
    const flags = (l.effects ?? {}) as { glow?: unknown; trails?: unknown };
    const glow = fx.bloom.enabled && flags.glow !== false;
    const trails = fx.trails.enabled && flags.trails !== false;
    if (glow) on.glow.push(String(l.id));
    if (trails) on.trails.push(String(l.id));
    return { ...l, effects: { glow: { ...fx.bloom, enabled: glow }, trails: { ...fx.trails, enabled: trails } } };
  });
  for (const [oldId, field, effect] of V7_PARAM_MOVES) {
    const param = parameters[oldId];
    if (param === undefined) continue;
    delete parameters[oldId];
    for (const id of on[effect]) parameters[`layer.${id}.${field}`] = structuredClone(param);
  }
  const { effects: _dropped, ...rest } = output;
  return { ...look, output: rest, layers: next, parameters };
}

/** migrations[n] upgrades a version-n document to version n + 1. */
export const migrations: Record<number, Migration> = {
  // v15: instancer layers get chart axes and value labels (all off).
  14: (doc) => {
    const withAxes = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => (l.type === 'instancer' && !l.axes ? { ...l, axes: defaultAxes() } : l)) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withAxes(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withAxes(sc.layers) })) };
  },
  // v16: instancer axes get `span`; existing ones keep growing with the visible rows.
  15: (doc) => {
    const withSpan = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Doc) => {
            const axes = l.axes as Doc | undefined;
            return l.type === 'instancer' && axes && axes.span === undefined ? { ...l, axes: { ...axes, span: 'visible' } } : l;
          })
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withSpan(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withSpan(sc.layers) })) };
  },
  // v17: every layer gets a row filter (empty: every row, as before).
  16: (doc) => {
    const withFilter = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => (l && typeof l === 'object' && l.filter === undefined ? { ...l, filter: [] } : l)) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withFilter(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withFilter(sc.layers) })) };
  },
  // v18: line layers get `split` (off: one line, as before); instancers get an x channel (unmapped).
  17: (doc) => {
    const upgrade = (l: Doc): Doc => {
      if (l?.type === 'line' && l.split === undefined) return { ...l, split: defaultLineSplit() };
      const channels = l?.channels as Doc | undefined;
      if (l?.type === 'instancer' && channels && channels.x === undefined) return { ...l, channels: { ...channels, x: defaultChannels().x } };
      return l;
    };
    const withSplit = (layers: unknown): unknown => (Array.isArray(layers) ? layers.map(upgrade) : layers);
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withSplit(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withSplit(sc.layers) })) };
  },
  // v19: density maps get dots mode (off: flat, as before).
  18: (doc) => {
    const withDots = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => (l?.type === 'density' && l.mode === undefined ? { ...l, ...defaultDensityDots() } : l)) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withDots(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withDots(sc.layers) })) };
  },
  // v20: line layers get axes (all off).
  19: (doc) => {
    const withAxes = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => (l?.type === 'line' && l.axes === undefined ? { ...l, axes: defaultAxes() } : l)) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withAxes(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withAxes(sc.layers) })) };
  },
  // v21: the horizon chart layer type; line splits get `stack` (off).
  20: (doc) => {
    const withStack = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Doc) => {
            const split = l?.split as Doc | undefined;
            return l?.type === 'line' && split && split.stack === undefined ? { ...l, split: { ...split, stack: 'none' } } : l;
          })
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withStack(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withStack(sc.layers) })) };
  },
  // v22: the camera (and every scene's) gets a follow setting (off).
  21: (doc) => {
    const withFollow = (camera: unknown): unknown =>
      camera && typeof camera === 'object' && (camera as Doc).follow === undefined ? { ...(camera as Doc), follow: defaultCameraFollow() } : camera;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, camera: withFollow(doc.camera), scenes: scenes.map((sc) => ({ ...sc, camera: withFollow(sc.camera) })) };
  },
  // v23: the follow camera gets its loop flight (on, 6 s, one turn, as new cameras).
  22: (doc) => {
    const withLoop = (camera: unknown): unknown => {
      const c = camera as Doc | undefined;
      const f = c?.follow as Doc | undefined;
      return c && f && f.loop === undefined ? { ...c, follow: { ...f, loop: true, loopSeconds: 6, loopTurns: 1 } } : camera;
    };
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, camera: withLoop(doc.camera), scenes: scenes.map((sc) => ({ ...sc, camera: withLoop(sc.camera) })) };
  },
  // v24: datasets get a "treat as missing" list (empty: only empty cells are missing, as before).
  23: (doc) => {
    const datasets = Array.isArray(doc.datasets) ? (doc.datasets as Doc[]) : doc.datasets;
    return { ...doc, datasets: Array.isArray(datasets) ? datasets.map((d) => (d && d.missing === undefined ? { ...d, missing: [] } : d)) : datasets };
  },
  // v25: instancer labels get `align`; existing ones stay at their row's first point.
  24: (doc) => {
    const withAlign = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Doc) => {
            const labels = l?.labels as Doc | undefined;
            return l?.type === 'instancer' && labels && labels.align === undefined ? { ...l, labels: { ...labels, align: 'point' } } : l;
          })
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withAlign(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withAlign(sc.layers) })) };
  },
  // v26: instancer labels get calendar month names, off.
  25: (doc) => {
    const withMonths = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Doc) => {
            const labels = l?.labels as Doc | undefined;
            return l?.type === 'instancer' && labels && labels.months === undefined
              ? { ...l, labels: { ...labels, months: { enabled: false, side: 'top', gridlines: false } } }
              : l;
          })
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withMonths(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withMonths(sc.layers) })) };
  },
  // v27: calendar `months` becomes `across`, a choice of unit (months keeps what v26 drew).
  26: (doc) => {
    const withAcross = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Doc) => {
            const labels = l?.labels as Doc | undefined;
            if (l?.type !== 'instancer' || !labels || labels.across !== undefined) return l;
            const { months, ...rest } = labels;
            const m = (months ?? {}) as Doc;
            const across = { enabled: m.enabled === true, unit: 'months', every: 1, dayText: 'date', side: m.side === 'bottom' ? 'bottom' : 'top', lines: m.gridlines === true };
            return { ...l, labels: { ...rest, across } };
          })
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withAcross(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withAcross(sc.layers) })) };
  },
  // v2: orbit camera replaces position/target; layers became typed (v1 never had any).
  1: (doc) => {
    const old = (doc.camera ?? {}) as { mode?: unknown; fov?: unknown };
    return {
      ...doc,
      camera: {
        ...defaultCamera(),
        mode: old.mode === '3d' ? '3d' : '2d',
        fov: typeof old.fov === 'number' && old.fov >= 5 && old.fov <= 120 ? old.fov : 45,
      },
      layers: [],
    };
  },
  // v3: every layer has a transform; instancers have a cloner. Parameters became typed in v2
  // without a bump; v2 files only ever had an empty object there, so nothing to convert.
  2: (doc) => {
    const layers = Array.isArray(doc.layers) ? (doc.layers as Record<string, unknown>[]) : [];
    return {
      ...doc,
      layers: layers.map((l) => ({
        ...l,
        transform: l.transform ?? identityTransform(),
        ...(l.type === 'instancer' && !l.cloner ? { cloner: identityCloner() } : {}),
      })),
    };
  },
  // v4: line layers gained a cloner and an area fill.
  3: (doc) => {
    const layers = Array.isArray(doc.layers) ? (doc.layers as Record<string, unknown>[]) : [];
    return {
      ...doc,
      layers: layers.map((l) =>
        l.type === 'line'
          ? { ...l, cloner: l.cloner ?? identityCloner(), fill: l.fill ?? { mode: 'none', colour: '#000000', opacity: 1 } }
          : l,
      ),
    };
  },
  // v5: output effects (bloom, trails), scenes and a default scene transition.
  4: (doc) => {
    const output = (doc.output ?? {}) as Record<string, unknown>;
    return {
      ...doc,
      output: { ...output, effects: output.effects ?? structuredClone(V5_EFFECTS) },
      scenes: doc.scenes ?? [],
      transition: doc.transition ?? defaultTransition(),
    };
  },
  // v6: every layer (also inside scenes) chooses whether glow and trails draw it; all on,
  // which is how v5 drew every layer.
  5: (doc) => {
    const withEffects = (layers: unknown): unknown =>
      Array.isArray(layers)
        ? layers.map((l: Record<string, unknown>) => ({ ...l, effects: l.effects ?? { glow: true, trails: true } }))
        : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Record<string, unknown>[]) : [];
    return {
      ...doc,
      layers: withEffects(doc.layers),
      scenes: scenes.map((sc) => ({ ...sc, layers: withEffects(sc.layers) })),
    };
  },
  // v7: glow and trails settings moved from the output onto each layer (perLayerEffects).
  6: (doc) => {
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...perLayerEffects(doc), scenes: scenes.map(perLayerEffects) };
  },
  // v8: every layer (also inside scenes) has a timeline; off, so it follows the project's.
  7: (doc) => {
    const withTimeline = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => ({ ...l, timeline: l.timeline ?? { own: false, duration: 600, loop: true } })) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withTimeline(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withTimeline(sc.layers) })) };
  },
  // v10: timelines play forward, reverse or ping-pong (forward); in-scene text gets a font
  // choice, where the 1970s terminal face is the new default, and an uppercase option; line
  // layers can aggregate (none).
  9: (doc) => {
    const layer = (l: Doc): Doc => {
      const out: Doc = { ...l, timeline: { ...((l.timeline ?? {}) as Doc), playback: 'forward' } };
      if (l.type === 'text') Object.assign(out, { font: typeof l.font === 'string' && l.font ? l.font : 'terminal', uppercase: false });
      if (l.type === 'instancer') out.labels = { ...((l.labels ?? {}) as Doc), font: 'terminal', uppercase: false };
      if (l.type === 'multiples' || l.type === 'hierarchy') Object.assign(out, { labelFont: 'terminal', labelUppercase: false });
      if (l.type === 'line') out.aggregate = { by: 'none', rows: 30, fn: 'mean' };
      return out;
    };
    const layers = (ls: unknown): unknown => (Array.isArray(ls) ? ls.map(layer) : ls);
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return {
      ...doc,
      timeline: { ...((doc.timeline ?? {}) as Doc), playback: 'forward' },
      layers: layers(doc.layers),
      scenes: scenes.map((sc) => ({ ...sc, layers: layers(sc.layers) })),
    };
  },
  // v14: datasets get source, url and attribution (empty).
  13: (doc) => {
    const datasets = Array.isArray(doc.datasets)
      ? (doc.datasets as Doc[]).map((d) => ({ source: '', url: '', attribution: '', ...d }))
      : doc.datasets;
    return { ...doc, datasets };
  },
  // v13: the camera (and each scene's) gets depth of field (off).
  12: (doc) => {
    const camera = (c: unknown): unknown =>
      c && typeof c === 'object' ? { dof: { enabled: false, focus: 0, depth: 200, amount: 12 }, ...(c as Doc) } : c;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, camera: camera(doc.camera), scenes: scenes.map((sc) => ({ ...sc, camera: camera(sc.camera) })) };
  },
  // v12: per-layer drop shadow and blur, "fixed to screen", camera projection, instancer
  // edge style (all off / perspective).
  11: (doc) => {
    const layer = (l: Doc): Doc => {
      const fx = (l.effects ?? {}) as Doc;
      const out: Doc = {
        ...l,
        screenFixed: l.screenFixed ?? false,
        effects: {
          ...fx,
          shadow: fx.shadow ?? { enabled: false, colour: '#000000', opacity: 0.6, spread: 8, offset: [6, -6] },
          blur: fx.blur ?? { enabled: false, amount: 4 },
        },
      };
      if (l.type === 'instancer' && !l.edges) out.edges = { enabled: false, colour: '#ff3030', width: 2, faceOpacity: 1, glow: 0 };
      return out;
    };
    const layers = (ls: unknown): unknown => (Array.isArray(ls) ? ls.map(layer) : ls);
    const camera = (c: unknown): unknown => (c && typeof c === 'object' ? { projection: 'perspective', ...(c as Doc) } : c);
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return {
      ...doc,
      camera: camera(doc.camera),
      layers: layers(doc.layers),
      scenes: scenes.map((sc) => ({ ...sc, camera: camera(sc.camera), layers: layers(sc.layers) })),
    };
  },
  // v11: small-multiples panel titles get a placement (outside, as before); the project
  // timeline can fade in / out and hold a gap where it restarts (all off).
  10: (doc) => {
    const layers = (ls: unknown): unknown =>
      Array.isArray(ls) ? ls.map((l: Doc) => (l.type === 'multiples' ? { ...l, labelPlacement: l.labelPlacement ?? 'outside' } : l)) : ls;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return {
      ...doc,
      timeline: { fadeIn: false, fadeOut: false, fadeLength: 1, gap: 0, ...((doc.timeline ?? {}) as Doc) },
      layers: layers(doc.layers),
      scenes: scenes.map((sc) => ({ ...sc, layers: layers(sc.layers) })),
    };
  },
  // v9: instancer layers can label points of their arrangement (off).
  8: (doc) => {
    const off = { enabled: false, every: 'year', rows: 365, text: 'date', column: null, size: 24, offset: 16, orientation: 'along', colour: '#e8e8e8', hidePoints: false };
    const withLabels = (layers: unknown): unknown =>
      Array.isArray(layers) ? layers.map((l: Doc) => (l.type === 'instancer' && !l.labels ? { ...l, labels: { ...off } } : l)) : layers;
    const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Doc[]) : [];
    return { ...doc, layers: withLabels(doc.layers), scenes: scenes.map((sc) => ({ ...sc, layers: withLabels(sc.layers) })) };
  },
};

export type MigrateResult =
  | { ok: true; project: Project; migratedFrom: number | null }
  | { ok: false; error: string };

/** Upgrade and validate an untrusted project document. Never throws. */
export function migrate(raw: unknown, table: Record<number, Migration> = migrations): MigrateResult {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'project is not a JSON object' };
    }
    let doc = raw as Record<string, unknown>;
    const start = doc.version;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) {
      return { ok: false, error: 'project has no valid "version" field' };
    }
    if (start > CURRENT_VERSION) {
      return { ok: false, error: `project version ${start} is newer than this build supports (${CURRENT_VERSION})` };
    }
    for (let v = start; v < CURRENT_VERSION; v++) {
      const step = table[v];
      if (!step) return { ok: false, error: `no migration from version ${v}` };
      doc = { ...step(doc), version: v + 1 };
    }
    const parsed = ProjectSchema.safeParse(doc);
    if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
    return { ok: true, project: parsed.data, migratedFrom: start === CURRENT_VERSION ? null : start };
  } catch (err) {
    return { ok: false, error: `migration failed: ${String(err)}` };
  }
}

/**
 * Session state: live, shared between windows, never saved with the project
 * (diagnostic toggles and calibration aids).
 */
export interface Session {
  testPattern: boolean;
  debugOverlay: boolean;
  transport: Transport;
  /** Transports of layers with their own timeline, by layer id (see LayerTimelineSchema). */
  layerTransports: Record<string, Transport>;
  /** The clock the camera's LFO and noise modulators run on (see ClockSchema). */
  cameraClock: Clock;
  /**
   * The most recent scene change. A control window sends it in the same patch that copies
   * the scene into the project; the output then morphs from what it was showing to the new
   * state over `duration` seconds from `startWallMs` (wall clock, see modulators.ts).
   * Each new `startWallMs` starts a new morph from whatever is on screen at that moment.
   */
  morph: Morph | null;
}

export interface Morph {
  startWallMs: number;
  duration: number;
  easing: (typeof EASINGS_MORPH)[number];
  sceneId: string | null;
}

export function defaultSession(nowMs = 0): Session {
  return { testPattern: false, debugOverlay: false, transport: { playing: true, anchorWallMs: nowMs, anchorPhase: 0 }, layerTransports: {}, cameraClock: { ...WALL_CLOCK }, morph: null };
}

/**
 * The document that patches address: paths start with "project" (saved in the project),
 * "session" (live, kept in server-state.json) or "profile" (the active output profile,
 * saved in output-profiles/).
 */
export interface SyncDoc {
  project: Project;
  session: Session;
  profile: OutputProfile;
}

export const MorphSchema = z.object({
  startWallMs: z.number(),
  duration: z.number().min(0.1).max(10),
  easing: z.enum(EASINGS_MORPH),
  sceneId: z.string().nullable(),
});

export const SessionSchema = z.object({
  testPattern: z.boolean(),
  debugOverlay: z.boolean(),
  transport: TransportSchema,
  /** Transports of layers with their own timeline, by layer id (see LayerTimelineSchema). */
  layerTransports: z.record(z.string(), TransportSchema).default({}),
  /** Sessions saved before camera clocks existed read as the wall clock, so nothing jumps. */
  cameraClock: ClockSchema.default(() => ({ ...WALL_CLOCK })),
  morph: MorphSchema.nullable().default(null),
});

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
