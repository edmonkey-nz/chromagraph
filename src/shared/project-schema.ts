import { z } from 'zod';

/**
 * project.json schema. Bump CURRENT_VERSION and add an entry to `migrations` whenever the
 * persisted shape changes. Migrations are pure functions from version N to N + 1.
 */
export const CURRENT_VERSION = 1;

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const DatasetSchema = z.object({
  id: z.string().min(1),
  /** File name inside the project's data/ folder. */
  file: z.string().min(1),
  label: z.string(),
  /** Display timezone. Timestamps are always held in UTC. */
  timeZone: z.string().min(1),
});

/** Layers are fleshed out in phase 3; the common header is fixed now. */
export const LayerSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  datasetId: z.string().nullable(),
});

export const ProjectSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  name: z.string(),
  datasets: z.array(DatasetSchema),
  layers: z.array(LayerSchema),
  parameters: z.record(z.string(), z.unknown()),
  timeline: z.object({
    /** Seconds for one full pass of the playhead. */
    duration: z.number().positive(),
    loop: z.boolean(),
  }),
  camera: z.object({
    mode: z.enum(['2d', '3d']),
    position: vec3,
    target: vec3,
    fov: z.number().positive(),
  }),
  output: z.object({
    background: hexColour,
  }),
});

export type Dataset = z.infer<typeof DatasetSchema>;
export type LayerConfig = z.infer<typeof LayerSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export function defaultProject(name: string): Project {
  return {
    version: CURRENT_VERSION,
    name,
    datasets: [],
    layers: [],
    parameters: {},
    timeline: { duration: 600, loop: true },
    camera: { mode: '2d', position: [0, 0, 1000], target: [0, 0, 0], fov: 45 },
    output: { background: '#000000' },
  };
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/** migrations[n] upgrades a version-n document to version n + 1. */
export const migrations: Record<number, Migration> = {};

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
}

export function defaultSession(): Session {
  return { testPattern: false, debugOverlay: false };
}

/** The document that patches address: paths start with "project" or "session". */
export interface SyncDoc {
  project: Project;
  session: Session;
}

export const SessionSchema = z.object({ testPattern: z.boolean(), debugOverlay: z.boolean() });

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
