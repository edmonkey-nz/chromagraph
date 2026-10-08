import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  InstancedBufferGeometry,
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
import { cellScratch, emptyStats, fillCells, heatmapDomain, textureShape, type Aggregate } from '../../../data/heatmap-data.ts';
import { rowRange } from '../../../data/line-data.ts';
import { prepareSurface, SURFACE_QUANTISE_STEPS, surfaceGrid } from '../../../data/surface-data.ts';
import type { ScaleType, SurfaceLayer } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { rampTexture } from './ramps.ts';

/**
 * 3D surface layer: a height field over the heat map's cells (calendar years x days, or rows
 * wrapped gridColumns per line), in one draw.
 *
 * The cells are one R32F data texture (built and refilled exactly as the heat map does).
 * The mesh has one vertex per cell centre: it is drawn as one instanced quad per cell, the
 * quad joining a cell to its right, lower and lower-right neighbours, and the vertex shader
 * finds its cell from gl_InstanceID and the corner. Each vertex fetches its value and rises
 * along +z by mix(height[0], height[1], norm(value)) (the instancer's scale maths); its
 * normal comes from central differences of the neighbouring cells (one-sided next to a
 * hole). So the grid shape (gridColumns), origin, cell size, heights, domain, scale, ramp,
 * lighting, wireframe and opacity are all uniforms; nothing is re-uploaded for them. The
 * calendar's `rows` and `aggregate` refill the texture in place; the grid's `rows` is a
 * uniform.
 *
 * Holes: a vertex on a missing cell passes vHole = 1, and the fragment shader discards every
 * fragment where the interpolated flag is above zero, i.e. every triangle touching a hole.
 * Nothing is interpolated across missing data.
 *
 * The wireframe is drawn in the same pass: fragments within about a pixel of a quad edge
 * take the wire colour (no diagonal, no second draw, no z-fighting).
 */

export interface SurfaceSourceData {
  table: Table;
  calendars: Record<string, CalendarFields>;
}

export interface SurfaceInstance extends LayerInstance {
  apply(layer: SurfaceLayer, cameraMode: '2d' | '3d'): void;
}

const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };

const vertexShader = /* glsl */ `
  #define MISSING_TEST -1.0e29

  uniform highp sampler2D uData;
  uniform int uTexWidth;
  uniform vec2 uGrid;       // vertex columns, vertex rows
  uniform float uCellCount;
  uniform float uGridRows;  // 1: grid layout, cells outside uRows are holes
  uniform vec2 uRows;
  uniform vec4 uScale;
  uniform vec2 uHeight;
  uniform vec3 uOrigin;
  uniform vec2 uCell;

  varying float vHole;
  varying float vNorm;
  varying vec3 vNormal;
  varying vec2 vQuad;

  // Scale maths; mirrors normalise() in src/data/instance-data.ts (clamped).
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

  // Cell value, or false for a hole; mirrors isHole() in src/data/surface-data.ts.
  bool valueAt(int c, int r, out float v) {
    v = 0.0;
    if (c < 0 || r < 0 || float(c) >= uGrid.x || float(r) >= uGrid.y) return false;
    float index = float(r) * uGrid.x + float(c);
    if (index >= uCellCount) return false;
    if (uGridRows > 0.5 && (index < uRows.x || index > uRows.y)) return false;
    int i = int(index);
    v = texelFetch(uData, ivec2(i % uTexWidth, i / uTexWidth), 0).r;
    return v > MISSING_TEST; // empty and void (not a date) cells are both below this
  }

  float heightOf(float v) { return mix(uHeight.x, uHeight.y, norm(v, uScale)); }

  void main() {
    int cols = int(uGrid.x);
    int c0 = gl_InstanceID % cols;
    int r0 = gl_InstanceID / cols;
    if (c0 >= cols - 1 || float(r0) >= uGrid.y - 1.0) {
      // No right or lower neighbour: this cell starts no quad.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vHole = 1.0; vNorm = 0.0; vNormal = vec3(0.0, 0.0, 1.0); vQuad = vec2(0.0);
      return;
    }
    int c = c0 + int(position.x);
    int r = r0 + int(position.y);

    float v;
    bool ok = valueAt(c, r, v);
    float n = ok ? norm(v, uScale) : 0.0;
    float h = ok ? mix(uHeight.x, uHeight.y, n) : 0.0;

    // Central differences over the neighbours, one-sided where a neighbour is a hole.
    float vl; float vr; float vu; float vd;
    bool okL = valueAt(c - 1, r, vl);
    bool okR = valueAt(c + 1, r, vr);
    bool okU = valueAt(c, r - 1, vu); // the row above (higher y)
    bool okD = valueAt(c, r + 1, vd);
    float hl = okL ? heightOf(vl) : h;
    float hr = okR ? heightOf(vr) : h;
    float hu = okU ? heightOf(vu) : h;
    float hd = okD ? heightOf(vd) : h;
    float spanX = (float(okL) + float(okR)) * uCell.x;
    float spanY = (float(okU) + float(okD)) * uCell.y;
    float dzdx = spanX > 0.0 ? (hr - hl) / spanX : 0.0;
    float dzdy = spanY > 0.0 ? (hu - hd) / spanY : 0.0;
    vec3 nrm = normalize(vec3(-dzdx, -dzdy, 1.0));

    vec3 p = uOrigin + vec3((float(c) + 0.5) * uCell.x, -(float(r) + 0.5) * uCell.y, h);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vHole = ok ? 0.0 : 1.0;
    vNorm = n;
    vNormal = normalize(normalMatrix * nrm);
    vQuad = position.xy;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uRamp;
  uniform float uReverse;
  uniform float uLit;
  uniform float uWire;
  uniform vec3 uWireColour;
  uniform float uOpacity;

  varying float vHole;
  varying float vNorm;
  varying vec3 vNormal;
  varying vec2 vQuad;

  void main() {
    // Any triangle touching a hole has vHole > 0 everywhere inside it.
    if (vHole > 0.0) discard;
    float n = uReverse > 0.5 ? 1.0 - vNorm : vNorm;
    vec3 col = texture2D(uRamp, vec2(n, 0.5)).rgb;
    if (uLit > 0.5) {
      // The instancer's fixed light.
      float diffuse = max(dot(normalize(vNormal), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
      col *= 0.35 + 0.65 * diffuse;
    }
    if (uWire > 0.5) {
      // Each quad draws half of each shared edge, so lines come out about 1 px wide.
      vec2 px = max(fwidth(vQuad), vec2(1.0e-5));
      vec2 e = min(vQuad, 1.0 - vQuad) / px;
      float w = 1.0 - smoothstep(0.0, 1.0, min(e.x, e.y));
      col = mix(col, uWireColour, w);
    }
    gl_FragColor = vec4(col, uOpacity);
  }
`;

export function createSurface(layer: SurfaceLayer, source: SurfaceSourceData, cameraMode: '2d' | '3d'): SurfaceInstance {
  const src = prepareSurface(layer, source.table, source.calendars);
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

  // As the heat map: the auto domain comes from cells built from every row, so heights stay
  // put while a data playhead sweeps `rows`. Only the calendar refills for `rows`.
  let autoAggregate: Aggregate | null = null;
  const autoStats = emptyStats();
  let filledAggregate: Aggregate | null = null;
  let filledFirst = -1;
  let filledLast = -1;

  function refill(aggregate: Aggregate, first: number, last: number): void {
    if (aggregate !== autoAggregate) {
      fillCells(src!, aggregate, 0, src!.rowCount - 1, cells, scratch, autoStats);
      autoAggregate = aggregate;
      autoDomainSet = false;
      filledAggregate = aggregate;
      filledFirst = 0;
      filledLast = src!.rowCount - 1;
      texture.needsUpdate = true;
    }
    if (src!.layout === 'grid') return;
    if (aggregate === filledAggregate && first === filledFirst && last === filledLast) return;
    fillCells(src!, aggregate, first, last, cells, scratch, stats);
    filledAggregate = aggregate;
    filledFirst = first;
    filledLast = last;
    texture.needsUpdate = true;
  }

  // One quad: corners are (column offset, row offset) from the instance's cell.
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.instanceCount = src.cellCount;

  const uniforms: Record<string, IUniform> = {
    uData: { value: texture },
    uTexWidth: { value: texW },
    uGrid: { value: new Vector2() },
    uCellCount: { value: src.cellCount },
    uGridRows: { value: src.layout === 'grid' ? 1 : 0 },
    uRows: { value: new Vector2() },
    uScale: { value: new Vector4() },
    uHeight: { value: new Vector2() },
    uOrigin: { value: new Vector3() },
    uCell: { value: new Vector2() },
    uRamp: { value: rampTexture(layer.ramp) },
    uReverse: { value: 0 },
    uLit: { value: 1 },
    uWire: { value: 0 },
    uWireColour: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  root.add(mesh);

  // Derived values, recomputed only when their inputs change (apply runs every frame for a
  // modulated layer, and this keeps it allocation-free otherwise).
  let rows0 = NaN;
  let rows1 = NaN;
  let gridColumns = NaN;
  let autoDomainSet = false;

  function apply(next: SurfaceLayer, mode: '2d' | '3d'): void {
    if (next.rows[0] !== rows0 || next.rows[1] !== rows1 || next.aggregate !== filledAggregate) {
      rows0 = next.rows[0];
      rows1 = next.rows[1];
      const [first, last] = rowRange(next.rows, src!.rowCount);
      refill(next.aggregate, first, last);
      (uniforms.uRows!.value as Vector2).set(first, last);
    }
    if (next.gridColumns !== gridColumns) {
      gridColumns = next.gridColumns;
      const [cols, rows] = surfaceGrid(src!, next.gridColumns);
      (uniforms.uGrid!.value as Vector2).set(cols, rows);
    }
    (uniforms.uOrigin!.value as Vector3).fromArray(next.origin);
    (uniforms.uCell!.value as Vector2).fromArray(next.cell);
    (uniforms.uHeight!.value as Vector2).fromArray(next.height);

    const scale = uniforms.uScale!.value as Vector4;
    if (next.domain) {
      scale.set(next.domain[0], next.domain[1], SCALE_CODE[next.scale], SURFACE_QUANTISE_STEPS);
      autoDomainSet = false;
    } else if (scale.z !== SCALE_CODE[next.scale] || !autoDomainSet) {
      // The auto domain only depends on the scale (and the aggregate, which refills autoStats).
      const domain = heatmapDomain(next.scale, null, autoStats);
      scale.set(domain[0], domain[1], SCALE_CODE[next.scale], SURFACE_QUANTISE_STEPS);
      autoDomainSet = true;
    }
    uniforms.uReverse!.value = next.reverse ? 1 : 0;
    uniforms.uRamp!.value = rampTexture(next.ramp);
    uniforms.uLit!.value = next.lit ? 1 : 0;
    uniforms.uWire!.value = next.wireframe ? 1 : 0;
    (uniforms.uWireColour!.value as Color).set(next.wireColour);
    uniforms.uOpacity!.value = next.opacity;

    // The instancer's depth rules: in 3D test depth, and write it only when opaque.
    const additive = next.blend === 'additive';
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
