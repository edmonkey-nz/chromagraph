import { z } from 'zod';
import { hexColour, identityCloner, identityTransform, LayerSchema, vec3 } from './layer-schema.ts';
import { ParameterSchema, TransportSchema, type Transport } from './modulators.ts';
import type { OutputProfile } from './output-profile.ts';

export { LayerSchema, type LayerConfig } from './layer-schema.ts';

/**
 * project.json schema. Bump CURRENT_VERSION and add an entry to `migrations` whenever the
 * persisted shape changes. Migrations are pure functions from version N to N + 1.
 */
export const CURRENT_VERSION = 5;


export const DatasetSchema = z.object({
  id: z.string().min(1),
  /** File name inside the project's data/ folder. */
  file: z.string().min(1),
  label: z.string(),
  /** Display timezone. Timestamps are always held in UTC. */
  timeZone: z.string().min(1),
});

/**
 * 2D: orthographic camera in output pixels. 3D: perspective camera orbiting a target; at
 * yaw = pitch = 0 and distance = 1 the z = 0 plane fills the frame exactly, so a 2D layout
 * looks the same in both modes until the camera moves.
 */
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
});
export type Camera = z.infer<typeof CameraSchema>;

/**
 * Whole-output effects, applied to the rendered 1080p image before the keystone warp.
 *   bloom   glow around bright marks (threshold = luminance where glow starts, 0..1)
 *   trails  motion trails: each frame keeps `persistence` of the previous one (0 = off,
 *           0.95 = long smears). Frame-rate independent: persistence is per 1/60 s.
 */
export const EffectsSchema = z.object({
  bloom: z.object({
    enabled: z.boolean(),
    strength: z.number().min(0).max(3),
    radius: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
  }),
  trails: z.object({
    enabled: z.boolean(),
    persistence: z.number().min(0).max(0.99),
  }),
});

export function defaultEffects(): z.infer<typeof EffectsSchema> {
  return {
    bloom: { enabled: false, strength: 0.8, radius: 0.4, threshold: 0.2 },
    trails: { enabled: false, persistence: 0.85 },
  };
}

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
  output: z.object({ background: hexColour, effects: EffectsSchema }),
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
    /** Seconds for one full pass of the playhead. */
    duration: z.number().positive(),
    loop: z.boolean(),
  }),
  camera: CameraSchema,
  output: z.object({
    background: hexColour,
    effects: EffectsSchema.default(defaultEffects),
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
export type Effects = z.infer<typeof EffectsSchema>;
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
    timeline: { duration: 600, loop: true },
    camera: defaultCamera(),
    output: { background: '#000000', effects: defaultEffects() },
    scenes: [],
    transition: defaultTransition(),
  };
}

export function defaultCamera(): Camera {
  return { mode: '2d', fov: 45, yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/** migrations[n] upgrades a version-n document to version n + 1. */
export const migrations: Record<number, Migration> = {
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
      output: { ...output, effects: output.effects ?? defaultEffects() },
      scenes: doc.scenes ?? [],
      transition: doc.transition ?? defaultTransition(),
    };
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
  return { testPattern: false, debugOverlay: false, transport: { playing: true, anchorWallMs: nowMs, anchorPhase: 0 }, morph: null };
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
  morph: MorphSchema.nullable().default(null),
});

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
