import type { InstancerLayer, LayerConfig } from './layer-schema.ts';
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

/** Fields every layer type has (opacity and its glow / trails settings; the transform is separate). */
const BASE_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  opacity: { label: 'opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'effects.glow.strength': { label: 'glow strength', min: 0, max: 3, hardMin: 0, hardMax: 3 },
  'effects.shadow.opacity': { label: 'shadow opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'effects.shadow.spread': { label: 'shadow spread', min: 0, max: 100, hardMin: 0, hardMax: 100 },
  'effects.shadow.offset': [
    { label: 'shadow x', min: -100, max: 100 },
    { label: 'shadow y', min: -100, max: 100 },
  ],
  'effects.blur.amount': { label: 'blur', min: 0, max: 100, hardMin: 0, hardMax: 100 },
  'effects.glow.radius': { label: 'glow radius', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'effects.glow.threshold': { label: 'glow threshold', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'effects.trails.persistence': { label: 'trail length', min: 0, max: 0.99, hardMin: 0, hardMax: 0.99 },
};

const TRANSFORM_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  position: AXES.map((a) => ({ label: `move ${a}`, min: -2000, max: 2000 })),
  rotation: AXES.map((a) => ({ label: `rotate ${a}`, min: -360, max: 360 })),
  scale: AXES.map((a) => ({ label: `scale ${a}`, min: 0, max: 5 })),
  pivot: AXES.map((a) => ({ label: `pivot ${a}`, min: -1000, max: 3000 })),
};

const ROWS: FieldSpec[] = [
  { label: 'rows start', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  { label: 'rows end', min: 0, max: 1, hardMin: 0, hardMax: 1 },
];
const ORIGIN: FieldSpec[] = [
  { label: 'origin x', min: -1920, max: 3840 },
  { label: 'origin y', min: -1080, max: 2160 },
  { label: 'origin z', min: -2000, max: 2000 },
];
const STEP: FieldSpec[] = AXES.map((a) => ({ label: `step ${a}`, min: -50, max: 50 }));
const CELL: FieldSpec[] = [
  { label: 'cell width', min: 0.1, max: 200 },
  { label: 'cell height', min: 0.1, max: 200 },
];

const LAYER_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  step: STEP,
  gridColumns: { label: 'grid columns', min: 1, max: 2000, hardMin: 1, integer: true },
  cell: CELL,
  radius: { label: 'radius', min: 0, max: 2000 },
  angleStep: { label: 'angle step', min: -360, max: 360 },
  radiusStep: { label: 'radius step', min: -50, max: 50 },
  size: [
    { label: 'width', min: 0, max: 500 },
    { label: 'height', min: 0, max: 500 },
    { label: 'depth', min: 0, max: 500 },
  ],
  'labels.size': { label: 'label size', min: 6, max: 200, hardMin: 6, hardMax: 200 },
  'edges.width': { label: 'edge width', min: 0.5, max: 20, hardMin: 0.5, hardMax: 20 },
  'edges.faceOpacity': { label: 'face opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'edges.glow': { label: 'edge glow', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  'labels.offset': { label: 'label offset', min: -200, max: 200 },
};

const CLONER_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  count: { label: 'clones', min: 1, max: 200, hardMin: 1, hardMax: 1000, integer: true },
  position: AXES.map((a) => ({ label: `clone step ${a}`, min: -200, max: 200 })),
  rotation: AXES.map((a) => ({ label: `clone rotate ${a}`, min: -180, max: 180 })),
  scale: AXES.map((a) => ({ label: `clone scale ${a}`, min: -0.5, max: 0.5 })),
  orbit: AXES.map((a) => ({ label: `clone orbit ${a}`, min: -180, max: 180 })),
  fade: { label: 'clone fade', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  dataStep: { label: 'clone data step', min: -1000, max: 1000, hardMin: -100_000, hardMax: 100_000, integer: true },
};

const LINE_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  step: STEP,
  width: { label: 'width', min: 1, max: 40, hardMin: 1, hardMax: 200 },
};

const HEATMAP_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  cell: CELL,
  gridColumns: { label: 'grid columns', min: 1, max: 2000, hardMin: 1, integer: true },
};

const MULTIPLES_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  columns: { label: 'panels per line', min: 1, max: 60, hardMin: 1, integer: true },
  panelSize: [
    { label: 'panel width', min: 10, max: 1920, hardMin: 1 },
    { label: 'panel height', min: 10, max: 1080, hardMin: 1 },
  ],
  gap: [
    { label: 'gap x', min: 0, max: 200 },
    { label: 'gap y', min: 0, max: 200 },
  ],
  markSize: { label: 'mark size', min: 0.05, max: 20, hardMin: 0.05, hardMax: 50 },
  labelSize: { label: 'label size', min: 0, max: 120, hardMin: 0, hardMax: 200 },
};

const HIERARCHY_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  size: [
    { label: 'width', min: 50, max: 3840, hardMin: 1 },
    { label: 'height', min: 50, max: 2160, hardMin: 1 },
  ],
  innerRadius: { label: 'inner radius', min: 0, max: 800, hardMin: 0 },
  nodeSize: [
    { label: 'node size min', min: 0, max: 60, hardMin: 0 },
    { label: 'node size max', min: 0, max: 120, hardMin: 0 },
  ],
  linkWidth: { label: 'link width', min: 0, max: 20, hardMin: 0, hardMax: 20 },
  linkOpacity: { label: 'link opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  padding: { label: 'padding', min: 0, max: 40, hardMin: 0, hardMax: 40 },
  labelSize: { label: 'label size', min: 8, max: 200, hardMin: 8, hardMax: 200 },
};

const SURFACE_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  rows: ROWS,
  origin: ORIGIN,
  cell: CELL,
  gridColumns: { label: 'grid columns', min: 1, max: 2000, hardMin: 1, integer: true },
  height: [
    { label: 'height min', min: -1000, max: 1000 },
    { label: 'height max', min: -1000, max: 1000 },
  ],
};

const TEXT_FIELDS: Record<string, FieldSpec | FieldSpec[]> = {
  row: { label: 'row', min: 0, max: 1, hardMin: 0, hardMax: 1 },
  position: AXES.map((a) => ({ label: `position ${a}`, min: -1000, max: 3000 })),
  fontSize: { label: 'font size', min: 8, max: 300, hardMin: 8, hardMax: 400 },
  maxWidth: { label: 'wrap width', min: 0, max: 1920, hardMin: 0 },
  lineHeight: { label: 'line height', min: 0.5, max: 3, hardMin: 0.5, hardMax: 3 },
  letterSpacing: { label: 'letter spacing', min: -0.5, max: 2, hardMin: -0.5, hardMax: 2 },
  outlineWidth: { label: 'outline width', min: 0, max: 20, hardMin: 0, hardMax: 20 },
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

function mappingDefs(out: ParamDef[], prefix: string, group: string, name: string, m: { column: string | null; domain: [number, number] | null; range?: [number, number] }, range?: [number, number, number?, number?]): void {
  if (!m.column) return;
  if (range && m.range) {
    const [lo, hi, hardLo, hardHi] = range;
    for (const i of [0, 1]) {
      out.push(
        def(`${prefix}.range.${i}`, group, {
          label: `${name} range ${i ? 'max' : 'min'}`,
          min: lo,
          max: hi,
          ...(hardLo !== undefined ? { hardMin: hardLo } : {}),
          ...(hardHi !== undefined ? { hardMax: hardHi } : {}),
        }),
      );
    }
  }
  if (m.domain) {
    const span = Math.max(Math.abs(m.domain[0]), Math.abs(m.domain[1]), 1);
    for (const i of [0, 1]) {
      out.push(def(`${prefix}.domain.${i}`, group, { label: `${name} domain ${i ? 'max' : 'min'}`, min: -span * 2, max: span * 2 }));
    }
  }
}

function instancerDefs(out: ParamDef[], layer: InstancerLayer, prefix: string, group: string): void {
  addFields(out, prefix, group, LAYER_FIELDS);
  addFields(out, `${prefix}.cloner`, group, CLONER_FIELDS);
  for (const ch of ['y', 'z', 'height', 'size', 'rotation', 'opacity'] as const) {
    mappingDefs(out, `${prefix}.channels.${ch}`, group, ch, layer.channels[ch], CHANNEL_RANGE[ch]);
  }
  mappingDefs(out, `${prefix}.channels.colour`, group, 'colour', layer.channels.colour);
}

function layerDefs(layer: LayerConfig): ParamDef[] {
  const out: ParamDef[] = [];
  const prefix = `layer.${layer.id}`;
  const group = layer.name || layer.id;
  addFields(out, prefix, group, BASE_FIELDS);
  addFields(out, `${prefix}.transform`, group, TRANSFORM_FIELDS);
  switch (layer.type) {
    case 'instancer':
      instancerDefs(out, layer, prefix, group);
      break;
    case 'line':
      addFields(out, prefix, group, LINE_FIELDS);
      mappingDefs(out, `${prefix}.y`, group, 'y', layer.y, CHANNEL_RANGE.y);
      mappingDefs(out, `${prefix}.z`, group, 'z', layer.z, CHANNEL_RANGE.z);
      mappingDefs(out, `${prefix}.colourMap`, group, 'colour', layer.colourMap);
      addFields(out, `${prefix}.cloner`, group, CLONER_FIELDS);
      addFields(out, `${prefix}.fill`, group, { opacity: { label: 'fill opacity', min: 0, max: 1, hardMin: 0, hardMax: 1 } });
      break;
    case 'multiples':
      addFields(out, prefix, group, MULTIPLES_FIELDS);
      if (layer.valueColumn && layer.domain) mappingDefs(out, prefix, group, 'value', { column: layer.valueColumn, domain: layer.domain });
      break;
    case 'hierarchy':
      addFields(out, prefix, group, HIERARCHY_FIELDS);
      if (layer.valueColumn && layer.domain) mappingDefs(out, prefix, group, 'value', { column: layer.valueColumn, domain: layer.domain });
      break;
    case 'surface':
      addFields(out, prefix, group, SURFACE_FIELDS);
      if (layer.valueColumn && layer.domain) mappingDefs(out, prefix, group, 'value', { column: layer.valueColumn, domain: layer.domain });
      break;
    case 'heatmap':
      addFields(out, prefix, group, HEATMAP_FIELDS);
      if (layer.valueColumn && layer.domain) {
        mappingDefs(out, prefix, group, 'value', { column: layer.valueColumn, domain: layer.domain });
      }
      break;
    case 'text':
      addFields(out, prefix, group, TEXT_FIELDS);
      break;
  }
  return out;
}

/** Every modulatable parameter in the project: camera, then layers in stack order. */
export function parameterDefs(project: Project): ParamDef[] {
  const out: ParamDef[] = [];
  addFields(out, 'camera', 'Camera', CAMERA_FIELDS);
  for (const layer of project.layers) out.push(...layerDefs(layer));
  return out;
}

export type ParamTarget =
  | { kind: 'camera'; path: (string | number)[] }
  | { kind: 'output'; path: (string | number)[] }
  | { kind: 'layer'; layerId: string; path: (string | number)[] };

/** Split an id into its owner and the path inside the camera or layer object. */
export function parseParamId(id: string): ParamTarget | null {
  const parts = id.split('.');
  const toPath = (segs: string[]) => segs.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (parts[0] === 'camera' && parts.length >= 2) return { kind: 'camera', path: toPath(parts.slice(1)) };
  if (parts[0] === 'output' && parts.length >= 2) return { kind: 'output', path: toPath(parts.slice(1)) };
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
  const owner =
    target.kind === 'camera'
      ? project.camera
      : target.kind === 'output'
        ? project.output
        : project.layers.find((l) => l.id === target.layerId);
  const v = readPath(owner, target.path);
  return typeof v === 'number' ? v : undefined;
}

/** Project-patch path for a parameter's base value (for control windows). */
export function paramPatchPath(project: Project, id: string): (string | number)[] | null {
  const target = parseParamId(id);
  if (!target) return null;
  if (target.kind === 'camera') return ['project', 'camera', ...target.path];
  if (target.kind === 'output') return ['project', 'output', ...target.path];
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
