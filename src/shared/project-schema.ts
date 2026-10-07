import { z } from 'zod';
import { hexColour, LayerSchema, vec3 } from './layer-schema.ts';
import { ParameterSchema, TransportSchema, type Transport } from './modulators.ts';
import type { OutputProfile } from './output-profile.ts';

export { LayerSchema, type LayerConfig } from './layer-schema.ts';

/**
 * project.json schema. Bump CURRENT_VERSION and add an entry to `migrations` whenever the
 * persisted shape changes. Migrations are pure functions from version N to N + 1.
 */
export const CURRENT_VERSION = 2;


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
  }),
});

export type Dataset = z.infer<typeof DatasetSchema>;
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
    output: { background: '#000000' },
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
}

export function defaultSession(nowMs = 0): Session {
  return { testPattern: false, debugOverlay: false, transport: { playing: true, anchorWallMs: nowMs, anchorPhase: 0 } };
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

export const SessionSchema = z.object({
  testPattern: z.boolean(),
  debugOverlay: z.boolean(),
  transport: TransportSchema,
});

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
