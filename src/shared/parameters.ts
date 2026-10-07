import type { InstancerLayer } from './layer-schema.ts';
import type { Project } from './project-schema.ts';

/**
 * Parameter registry: every numeric value that can be modulated (and later mapped to
 * MIDI/OSC), with a stable id, a label, a UI range and its hard valid range.
 *
 * Id format (dot-separated, stable across layer reordering because layers go by id):
 *   camera.<field>[.<index>]                      e.g. camera.yaw, camera.target.0
 *   layer.<layerId>.<field>[.<index>]             e.g. layer.ly-ab12.opacity, layer.ly-ab12.rows.1
 *   layer.<layerId>.channels.<channel>.<range|domain>.<0|1>
 *
 * A parameter's base value is the plain value in project state; project.parameters[id]
 * holds its modulator. The output computes base + modulator each frame and clamps to
 * [hardMin, hardMax] (and rounds integers) so a modulated config is always valid.
 */

export interface ParamDef {
  id: string;
  label: string;
  /** For grouping in UIs: "Camera" or the layer name. */
  group: string;
  /** Suggested UI slider range. */
  min: number;
  max: number;
  /** Values outside these are clamped (schema validity). */
  hardMin: number;
  hardMax: number;
  integer: boolean;
}

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  hardMin?: number;
  hardMax?: number;
  integer?: boolean;
}

const BIG = 1e9;
const AXES = ['x', 'y', 'z'];

const CAMERA_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  fov: { label: 'field of view', min: 5, max: 120, hardMin: 5, hardMax: 120 },
  yaw: { label: 'yaw', min: -180, max: 180 },
  pitch: { label: 'pitch', min: -89, max: 89, hardMin: -89, hardMax: 89 },
  distance: { label: 'distance', min: 0.2, max: 5, hardMin: 0.01 },
  target: AXES.map((a) => ({ label: `target ${a}`, min: -2000, max: 2000 })),
};

const LAYER_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  opacity: { label: 'opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  rows: [
    { label: 'rows start', min: 0, max: 1, hardMin: 0, hardMax: 1 },
    { label: 'rows end', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  ],
  origin: [
    { label: 'origin x', min: -1920, max: 3840 },
    { label: 'origin y', min: -1080, max: 2160 },
    { label: 'origin z', min: -2000, max: 2000 },
  ],
  step: AXES.map((a) => ({ label: `step ${a}`, min: -50, max: 50 })),
  gridColumns: { label: 'grid columns', min: 1, max: 2000, hardMin: 1, integer: true },
  cell: [
    { label: 'cell width', min: 0.1, max: 200 },
    { label: 'cell height', min: 0.1, max: 200 },
  ],
  radius: { label: 'radius', min: 0, max: 2000 },
  angleStep: { label: 'angle step', min: -360, max: 360 },
  radiusStep: { label: 'radius step', min: -50, max: 50 },
  size: [
    { label: 'width', min: 0, max: 500 },
    { label: 'height', min: 0, max: 500 },
    { label: 'depth', min: 0, max: 500 },
  ],
};

const CHANNEL_RANGE: Record<string, [number, number, number?, number?]> = {
  y: [-2000, 2000],
  z: [-2000, 2000],
  height: [-1000, 1000],
  size: [0, 20],
  rotation: [-720, 720],
  opacity: [0, 1, 0, 1],
};

function def(id: string, group: string, spec: FieldSpec): ParamDef {
  return {
    id,
    label: spec.label,
    group,
    min: spec.min,
    max: spec.max,
    hardMin: spec.hardMin ?? -BIG,
    hardMax: spec.hardMax ?? BIG,
    integer: spec.integer ?? false,
  };
}

function addFields(out: ParamDef[], prefix: string, group: string, fields: Record<string, FieldSpec | FieldSpec[]>): void {
  for (const [field, spec] of Object.entries(fields)) {
    if (Array.isArray(spec)) spec.forEach((s, i) => out.push(def(`${prefix}.${field}.${i}`, group, s)));
    else out.push(def(`${prefix}.${field}`, group, spec));
  }
}

function layerDefs(layer: InstancerLayer): ParamDef[] {
  const out: ParamDef[] = [];
  const prefix = `layer.${layer.id}`;
  const group = layer.name || layer.id;
  addFields(out, prefix, group, LAYER_FIELDS);
  for (const [ch, [lo, hi, hardLo, hardHi]] of Object.entries(CHANNEL_RANGE)) {
    const m = layer.channels[ch as keyof typeof CHANNEL_RANGE & keyof InstancerLayer['channels']];
    if (!m?.column) continue;
    for (const i of [0, 1]) {
      out.push(
        def(`${prefix}.channels.${ch}.range.${i}`, group, {
          label: `${ch} range ${i ? 'max' : 'min'}`,
          min: lo,
          max: hi,
          ...(hardLo !== undefined ? { hardMin: hardLo } : {}),
          ...(hardHi !== undefined ? { hardMax: hardHi } : {}),
        }),
      );
    }
  }
  for (const ch of ['y', 'z', 'height', 'size', 'rotation', 'opacity', 'colour'] as const) {
    const m = layer.channels[ch];
    if (!m.column || !m.domain) continue;
    const span = Math.max(Math.abs(m.domain[0]), Math.abs(m.domain[1]), 1);
    for (const i of [0, 1]) {
      out.push(def(`${prefix}.channels.${ch}.domain.${i}`, group, { label: `${ch} domain ${i ? 'max' : 'min'}`, min: -span * 2, max: span * 2 }));
    }
  }
  return out;
}

/** Every modulatable parameter in the project, camera first, then layers in stack order. */
export function parameterDefs(project: Project): ParamDef[] {
  const out: ParamDef[] = [];
  addFields(out, 'camera', 'Camera', CAMERA_FIELDS);
  for (const layer of project.layers) if (layer.type === 'instancer') out.push(...layerDefs(layer));
  return out;
}

export type ParamTarget =
  | { kind: 'camera'; path: (string | number)[] }
  | { kind: 'layer'; layerId: string; path: (string | number)[] };

/** Split an id into its owner and the path inside the camera or layer object. */
export function parseParamId(id: string): ParamTarget | null {
  const parts = id.split('.');
  const toPath = (segs: string[]) => segs.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (parts[0] === 'camera' && parts.length >= 2) return { kind: 'camera', path: toPath(parts.slice(1)) };
  if (parts[0] === 'layer' && parts.length >= 3 && parts[1]) return { kind: 'layer', layerId: parts[1], path: toPath(parts.slice(2)) };
  return null;
}

function readPath(obj: unknown, path: (string | number)[]): unknown {
  let node = obj;
  for (const k of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[k];
  }
  return node;
}

/** Base value of a parameter in the project, or undefined if it does not exist. */
export function readParam(project: Project, id: string): number | undefined {
  const target = parseParamId(id);
  if (!target) return undefined;
  const owner = target.kind === 'camera' ? project.camera : project.layers.find((l) => l.id === target.layerId);
  const v = readPath(owner, target.path);
  return typeof v === 'number' ? v : undefined;
}

/** Project-patch path for a parameter's base value (for control windows). */
export function paramPatchPath(project: Project, id: string): (string | number)[] | null {
  const target = parseParamId(id);
  if (!target) return null;
  if (target.kind === 'camera') return ['project', 'camera', ...target.path];
  const index = project.layers.findIndex((l) => l.id === target.layerId);
  return index < 0 ? null : ['project', 'layers', index, ...target.path];
}

export function clampParam(def: Pick<ParamDef, 'hardMin' | 'hardMax' | 'integer'>, v: number): number {
  if (!Number.isFinite(v)) return Math.min(Math.max(0, def.hardMin), def.hardMax);
  const c = Math.min(Math.max(v, def.hardMin), def.hardMax);
  return def.integer ? Math.round(c) : c;
}

/** Parameter ids that belong to a layer (to remove its modulators when the layer goes). */
export function layerParamPrefix(layerId: string): string {
  return `layer.${layerId}.`;
}
