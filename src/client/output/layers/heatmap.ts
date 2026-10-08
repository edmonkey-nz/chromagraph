import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  Mesh,
  NearestFilter,
  NormalBlending,
  RedFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import type { CalendarFields } from '../../../data/calendar.ts';
import type { Table } from '../../../data/columns.ts';
import {
  cellScratch,
  emptyStats,
  fillCells,
  heatmapDomain,
  heatmapGrid,
  prepareHeatmap,
  textureShape,
  type Aggregate,
} from '../../../data/heatmap-data.ts';
import { rowRange } from '../../../data/line-data.ts';
import type { HeatmapLayer, ScaleType } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { rampTexture } from './ramps.ts';

/**
 * Heat map layer: one quad and one R32F data texture (one texel per cell, packed
 * DATA_TEX_WIDTH wide). The fragment shader finds the cell under the pixel, fetches its
 * value, applies the scale (the instancer's `norm` maths) and the ramp, and handles empty
 * cells per `missing`. Cell size, origin, grid columns, scale, domain, ramp and the missing
 * colour are uniforms. The calendar's `rows` and `aggregate` refill the texture in place
 * (only when they actually change); the grid's `rows` is a uniform.
 */

export interface HeatmapSourceData {
  table: Table;
  calendars: Record<string, CalendarFields>;
}

export interface HeatmapInstance extends LayerInstance {
  apply(layer: HeatmapLayer, cameraMode: '2d' | '3d'): void;
}

const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };

const vertexShader = /* glsl */ `
  uniform vec3 uOrigin;
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    // position.xy runs 0..1 right and 0..-1 down from the top-left corner.
    vUv = vec2(position.x, -position.y);
    vec3 p = uOrigin + vec3(position.x * uSize.x, position.y * uSize.y, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MISSING_TEST -1.0e29
  #define VOID_TEST -2.0e30

  uniform sampler2D uData;
  uniform int uTexWidth;
  uniform vec2 uGrid;       // cells across, cells down
  uniform float uCellCount;
  uniform float uGridRows;  // 1: grid layout, cells outside uRows count as empty
  uniform vec2 uRows;
  uniform vec4 uScale;
  uniform float uReverse;
  uniform sampler2D uRamp;
  uniform float uMissingColour;
  uniform vec3 uMissing;
  uniform float uOpacity;
  varying vec2 vUv;

  // Scale maths; mirrors normalise() in src/data/instance-data.ts.
  float fwd(float x, float type) {
    if (type == 1.0) return log(max(x, 1.0e-30));
    if (type == 2.0) return sign(x) * sqrt(abs(x));
    return x;
  }
  float norm(float v, vec4 s) {
    float a = fwd(s.x, s.z);
    float b = fwd(s.y, s.z);
    float n = (b == a) ? 0.5 : (fwd(v, s.z) - a) / (b - a);
    if (s.z == 3.0) n = floor(clamp(n, 0.0, 0.99999) * s.w) / (s.w - 1.0);
    return clamp(n, 0.0, 1.0);
  }

  void main() {
    vec2 cell = min(floor(vUv * uGrid), uGrid - 1.0);
    float index = cell.y * uGrid.x + cell.x;
    if (index >= uCellCount) discard;
    int i = int(index);
    float v = texelFetch(uData, ivec2(i % uTexWidth, i / uTexWidth), 0).r;
    if (v < VOID_TEST) discard; // not a date (calendar day 366 of a common year)
    bool empty = v < MISSING_TEST || (uGridRows > 0.5 && (index < uRows.x || index > uRows.y));
    vec3 colour;
    if (empty) {
      if (uMissingColour < 0.5) discard;
      colour = uMissing;
    } else {
      float n = norm(v, uScale);
      if (uReverse > 0.5) n = 1.0 - n;
      colour = texture2D(uRamp, vec2(n, 0.5)).rgb;
    }
    gl_FragColor = vec4(colour, uOpacity);
  }
`;

export function createHeatmap(layer: HeatmapLayer, source: HeatmapSourceData, cameraMode: '2d' | '3d'): HeatmapInstance {
  const src = prepareHeatmap(layer, source.table, source.calendars);
  const root = new Group();
  root.name = layer.name;
  if (!src || src.cellCount === 0) {
    // Not configured yet (no value column, or calendar without a time column): draw nothing.
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }

  const [texW, texH] = textureShape(src.cellCount);
  const cells = new Float32Array(texW * texH);
  const scratch = cellScratch(src);
  const stats = emptyStats();
  const texture = new DataTexture(cells, texW, texH, RedFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;

  // Auto domains come from the cells built from every row (not just the `rows` range), so
  // colours stay put while a data playhead sweeps. They depend on the aggregate only.
  let autoAggregate: Aggregate | null = null;
  const autoStats = emptyStats();
  let filledAggregate: Aggregate | null = null;
  let filledFirst = -1;
  let filledLast = -1;

  function refill(aggregate: Aggregate, first: number, last: number): void {
    if (aggregate !== autoAggregate) {
      fillCells(src!, aggregate, 0, src!.rowCount - 1, cells, scratch, autoStats);
      autoAggregate = aggregate;
      filledAggregate = aggregate;
      filledFirst = 0;
      filledLast = src!.rowCount - 1;
      texture.needsUpdate = true;
    }
    // Grid cells are rows, so the range is a uniform there; only the calendar refills.
    if (src!.layout === 'grid') return;
    if (aggregate === filledAggregate && first === filledFirst && last === filledLast) return;
    fillCells(src!, aggregate, first, last, cells, scratch, stats);
    filledAggregate = aggregate;
    filledFirst = first;
    filledLast = last;
    texture.needsUpdate = true;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, -1, 0, 0, -1, 0]), 3));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);

  const uniforms: Record<string, IUniform> = {
    uOrigin: { value: new Vector3() },
    uSize: { value: new Vector2() },
    uData: { value: texture },
    uTexWidth: { value: texW },
    uGrid: { value: new Vector2() },
    uCellCount: { value: src.cellCount },
    uGridRows: { value: src.layout === 'grid' ? 1 : 0 },
    uRows: { value: new Vector2() },
    uScale: { value: new Vector4() },
    uReverse: { value: 0 },
    uRamp: { value: rampTexture(layer.ramp) },
    uMissingColour: { value: 0 },
    uMissing: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  root.add(mesh);

  function apply(next: HeatmapLayer, mode: '2d' | '3d'): void {
    const [first, last] = rowRange(next.rows, src!.rowCount);
    refill(next.aggregate, first, last);
    (uniforms.uRows!.value as Vector2).set(first, last);

    const [cols, rows] = heatmapGrid(src!, next.gridColumns);
    (uniforms.uGrid!.value as Vector2).set(cols, rows);
    (uniforms.uSize!.value as Vector2).set(cols * next.cell[0], rows * next.cell[1]);
    (uniforms.uOrigin!.value as Vector3).fromArray(next.origin);

    const domain = heatmapDomain(next.scale, next.domain, autoStats);
    (uniforms.uScale!.value as Vector4).set(domain[0], domain[1], SCALE_CODE[next.scale], next.steps);
    uniforms.uReverse!.value = next.reverse ? 1 : 0;
    uniforms.uRamp!.value = rampTexture(next.ramp);
    uniforms.uMissingColour!.value = next.missing === 'colour' ? 1 : 0;
    (uniforms.uMissing!.value as Color).set(next.missingColour);
    uniforms.uOpacity!.value = next.opacity;

    const additive = next.blend === 'additive';
    // Transparent empty cells are discarded, so they do not make the layer translucent.
    const translucent = additive || next.opacity < 1;
    material.transparent = translucent;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
    root.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {},
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
