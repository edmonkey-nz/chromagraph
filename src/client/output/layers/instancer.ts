import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  NormalBlending,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import type { CalendarFields } from '../../../data/calendar.ts';
import type { Table } from '../../../data/columns.ts';
import type { Cadence } from '../../../data/gaps.ts';
import {
  buildInstanceData,
  firstDefinedT,
  resolveDomain,
  type ChannelData,
  type ChannelName,
  type InstanceData,
} from '../../../data/instance-data.ts';
import type { ColourMapping, InstancerLayer, Mapping, Primitive, ScaleType } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { paletteTexture, PALETTE, rampTexture } from './ramps.ts';

/**
 * Instancer layer: every visible data row (times the cloner count) in one instanced draw.
 *
 * Per-row data lives in three RGBA32F data textures, read in the vertex shader with
 * texelFetch from gl_InstanceID:
 *   data0  t, year index, day of year, (unused)
 *   data1  y, z, height, size channel values
 *   data2  rotation, opacity, colour channel values, (unused)
 * Missing values hold the MISSING sentinel and hide their instance.
 *
 * Instances are only issued for the visible row range: instanceCount = visible rows x
 * clones, and the shader maps gl_InstanceID to (row, clone). Changing the row range, any
 * mapping domain/range/scale or any cloner setting is therefore a uniform update — nothing
 * is re-uploaded. Only changing which columns are used rebuilds the textures.
 *
 * Cloner: clone k of row i sits at row i's arranged position, offset by the clone steps,
 * and takes its mapped values from row i + k * dataStep (waterfall / echo effects).
 * Clones are drawn far to near so the original (k = 0) is on top.
 */

export interface InstancerData {
  table: Table;
  cadences: Record<string, Cadence>;
  calendars: Record<string, CalendarFields>;
}

export interface InstancerInstance extends LayerInstance {
  apply(layer: InstancerLayer, cameraMode: '2d' | '3d'): void;
}

/** Texture width for row lookups (row -> (row % W, row / W)). 4096 is guaranteed by WebGL2. */
const TEX_WIDTH = 4096;
/** Hard ceiling on instances per draw so a mistyped clone count cannot hang the GPU. */
const MAX_DRAWN = 4_000_000;

const ARRANGEMENT_CODE = { linear: 0, grid: 1, calendar: 2, radial: 3, spiral: 4 } as const;
const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };

/** Channel -> [define, uniform suffix, texture, component]. */
const CHANNELS: { name: ChannelName; define: string; suffix: string; tex: 1 | 2; comp: number }[] = [
  { name: 'y', define: 'CH_Y', suffix: 'Y', tex: 1, comp: 0 },
  { name: 'z', define: 'CH_Z', suffix: 'Z', tex: 1, comp: 1 },
  { name: 'height', define: 'CH_HEIGHT', suffix: 'Height', tex: 1, comp: 2 },
  { name: 'size', define: 'CH_SIZE', suffix: 'Size', tex: 1, comp: 3 },
  { name: 'rotation', define: 'CH_ROTATION', suffix: 'Rotation', tex: 2, comp: 0 },
  { name: 'opacity', define: 'CH_OPACITY', suffix: 'Opacity', tex: 2, comp: 1 },
  { name: 'colour', define: 'CH_COLOUR', suffix: 'Colour', tex: 2, comp: 2 },
];

function baseGeometry(primitive: Primitive): BufferGeometry {
  switch (primitive) {
    case 'point':
    case 'square':
      return new PlaneGeometry(1, 1);
    case 'bar':
      // Anchored at its base so a mapped height grows upward (or downward if negative).
      return new PlaneGeometry(1, 1).translate(0, 0.5, 0);
    case 'box':
      return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    case 'sphere':
      return new IcosahedronGeometry(0.5, 2);
  }
}

/** Pack up to four per-row arrays into an RGBA32F texture (absent components are 0). */
function packTexture(n: number, components: (Float32Array | null)[]): DataTexture {
  const height = Math.max(1, Math.ceil(n / TEX_WIDTH));
  const data = new Float32Array(TEX_WIDTH * height * 4);
  for (let c = 0; c < 4; c++) {
    const src = components[c];
    if (!src) continue;
    for (let i = 0; i < n; i++) data[i * 4 + c] = src[i]!;
  }
  const tex = new DataTexture(data, TEX_WIDTH, height, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const vertexShader = /* glsl */ `
  #define MISSING_TEST -1.0e29
  #define TEX_WIDTH ${TEX_WIDTH}

  uniform highp sampler2D uData0;
  uniform highp sampler2D uData1;
  uniform highp sampler2D uData2;

  #ifdef CH_Y
    uniform vec4 uScaleY; uniform vec3 uRangeY;
  #endif
  #ifdef CH_Z
    uniform vec4 uScaleZ; uniform vec3 uRangeZ;
  #endif
  #ifdef CH_HEIGHT
    uniform vec4 uScaleHeight; uniform vec3 uRangeHeight;
  #endif
  #ifdef CH_SIZE
    uniform vec4 uScaleSize; uniform vec3 uRangeSize;
  #endif
  #ifdef CH_ROTATION
    uniform vec4 uScaleRotation; uniform vec3 uRangeRotation;
  #endif
  #ifdef CH_OPACITY
    uniform vec4 uScaleOpacity; uniform vec3 uRangeOpacity;
  #endif
  #ifdef CH_COLOUR
    uniform vec4 uScaleColour;
    uniform float uCategories;
  #endif
  uniform float uReverse;
  uniform float uColourByClone;
  uniform sampler2D uRamp;

  uniform int uArrangement;
  uniform vec3 uOrigin;
  uniform vec3 uStep;
  uniform float uGridColumns;
  uniform vec2 uCell;
  uniform float uRadius;
  uniform float uAngleStep;
  uniform float uRadiusStep;
  uniform int uFirstRow;
  uniform int uVisibleRows;
  uniform int uRowCount;
  uniform float uTStart;
  uniform vec3 uSize;
  uniform float uHeightAlongZ;
  uniform vec3 uColour;
  uniform float uOpacity;

  // Cloner.
  uniform int uClones;
  uniform vec3 uClonePosition;
  uniform vec3 uCloneRotation;  // radians per clone
  uniform vec3 uCloneScale;
  uniform vec3 uCloneOrbit;     // radians per clone
  uniform float uCloneFade;
  uniform int uDataStep;
  uniform vec3 uPivot;

  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec3 vNormal;

  vec4 fetchRow(highp sampler2D tex, int row) {
    return texelFetch(tex, ivec2(row % TEX_WIDTH, row / TEX_WIDTH), 0);
  }

  // Scale maths; mirrors normalise() in src/data/instance-data.ts.
  float fwd(float x, float type) {
    if (type == 1.0) return log(max(x, 1.0e-30));
    if (type == 2.0) return sign(x) * sqrt(abs(x));
    return x;
  }
  float norm(float v, vec4 s, float clampIt) {
    float a = fwd(s.x, s.z);
    float b = fwd(s.y, s.z);
    float n = (b == a) ? 0.5 : (fwd(v, s.z) - a) / (b - a);
    if (s.z == 3.0) n = floor(clamp(n, 0.0, 0.99999) * s.w) / (s.w - 1.0);
    else if (clampIt > 0.5) n = clamp(n, 0.0, 1.0);
    return n;
  }
  float mapChannel(float v, vec4 s, vec3 r) { return mix(r.x, r.y, norm(v, s, r.z)); }

  mat3 eulerXYZ(vec3 a) {
    vec3 c = cos(a);
    vec3 s = sin(a);
    mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, c.x, s.x, 0.0, -s.x, c.x);
    mat3 ry = mat3(c.y, 0.0, -s.y, 0.0, 1.0, 0.0, s.y, 0.0, c.y);
    mat3 rz = mat3(c.z, s.z, 0.0, -s.z, c.z, 0.0, 0.0, 0.0, 1.0);
    return rx * ry * rz; // three's Euler order 'XYZ' is the matrix Rx * Ry * Rz
  }

  void hideInstance() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColour = vec3(0.0);
    vUv = vec2(0.0);
    vNormal = vec3(0.0, 0.0, 1.0);
  }

  void main() {
    // Clone-major and far-to-near: the last instances drawn are clone 0 (the originals).
    int perClone = max(uVisibleRows, 1);
    int k = (uClones - 1) - gl_InstanceID / perClone;
    int row = uFirstRow + gl_InstanceID % perClone;
    int dataRow = row + k * uDataStep;
    if (k < 0 || dataRow < 0 || dataRow >= uRowCount) { hideInstance(); return; }

    vec4 d0 = fetchRow(uData0, row);       // arrangement comes from the base row
    vec4 d1 = fetchRow(uData1, dataRow);   // values come from the (stepped) data row
    vec4 d2 = fetchRow(uData2, dataRow);

    bool hidden = d0.x < MISSING_TEST;
    #ifdef CALENDAR
      hidden = hidden || d0.y < MISSING_TEST;
    #endif
    #ifdef CH_Y
      hidden = hidden || d1.x < MISSING_TEST;
    #endif
    #ifdef CH_Z
      hidden = hidden || d1.y < MISSING_TEST;
    #endif
    #ifdef CH_HEIGHT
      hidden = hidden || d1.z < MISSING_TEST;
    #endif
    #ifdef CH_SIZE
      hidden = hidden || d1.w < MISSING_TEST;
    #endif
    #ifdef CH_ROTATION
      hidden = hidden || d2.x < MISSING_TEST;
    #endif
    #ifdef CH_OPACITY
      hidden = hidden || d2.y < MISSING_TEST;
    #endif
    #ifdef CH_COLOUR
      hidden = hidden || (d2.z < MISSING_TEST && uColourByClone < 0.5);
    #endif
    if (hidden) { hideInstance(); return; }

    float t = d0.x - uTStart;
    vec3 p;
    if (uArrangement == 0) {
      p = uOrigin + t * uStep;
    } else if (uArrangement == 1) {
      float col = mod(t, uGridColumns);
      float line = floor(t / uGridColumns);
      p = uOrigin + vec3(col * uCell.x, -line * uCell.y, 0.0);
    } else if (uArrangement == 2) {
      p = uOrigin + vec3(d0.z * uCell.x, -d0.y * uCell.y, 0.0);
    } else {
      float ang = radians(t * uAngleStep);
      float r = uRadius + (uArrangement == 4 ? t * uRadiusStep : 0.0);
      p = uOrigin + vec3(sin(ang) * r, cos(ang) * r, 0.0);
    }

    vec3 size = uSize;
    float rot = 0.0;
    #ifdef CH_HEIGHT
      size.y = mapChannel(d1.z, uScaleHeight, uRangeHeight);
    #endif
    #ifdef CH_SIZE
      size *= mapChannel(d1.w, uScaleSize, uRangeSize);
    #endif
    #ifdef CH_ROTATION
      rot = radians(mapChannel(d2.x, uScaleRotation, uRangeRotation));
    #endif
    #ifdef CH_Y
      p.y += mapChannel(d1.x, uScaleY, uRangeY);
    #endif
    #ifdef CH_Z
      p.z += mapChannel(d1.y, uScaleZ, uRangeZ);
    #endif

    // Clone offsets: step, then orbit about the layer pivot.
    float fk = float(k);
    p += fk * uClonePosition;
    if (k > 0 && uCloneOrbit != vec3(0.0)) p = uPivot + eulerXYZ(fk * uCloneOrbit) * (p - uPivot);
    vec3 cloneScale = max(vec3(0.0), vec3(1.0) + fk * uCloneScale);
    mat3 cloneRot = eulerXYZ(fk * uCloneRotation);

    // Height along z: swap the primitive's y and z (its base stays at its origin).
    vec3 pos = uHeightAlongZ > 0.5 ? position.xzy : position;
    vec3 nrm = uHeightAlongZ > 0.5 ? normal.xzy : normal;
    vec3 local = pos * (uHeightAlongZ > 0.5 ? size.xzy : size);
    float c = cos(rot);
    float s = sin(rot);
    local.xy = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
    nrm.xy = vec2(c * nrm.x - s * nrm.y, s * nrm.x + c * nrm.y);
    local = cloneRot * (local * cloneScale);
    nrm = cloneRot * nrm;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p + local, 1.0);

    vec3 colour = uColour;
    float cn = -1.0;
    if (uColourByClone > 0.5) {
      cn = uClones > 1 ? fk / float(uClones - 1) : 0.0;
    }
    #ifdef CH_COLOUR
      else if (uCategories > 0.0) {
        cn = (mod(d2.z, ${PALETTE.length.toFixed(1)}) + 0.5) / ${PALETTE.length.toFixed(1)};
      } else {
        cn = norm(d2.z, uScaleColour, 1.0);
      }
    #endif
    if (cn >= 0.0) {
      if (uReverse > 0.5) cn = 1.0 - cn;
      colour = texture2D(uRamp, vec2(cn, 0.5)).rgb;
    }

    float alpha = uOpacity * (k == 0 ? 1.0 : pow(uCloneFade, fk)); // pow(0, 0) is undefined in GLSL
    #ifdef CH_OPACITY
      alpha *= clamp(mapChannel(d2.y, uScaleOpacity, uRangeOpacity), 0.0, 1.0);
    #endif

    vColour = colour;
    vAlpha = alpha;
    vUv = uv;
    vNormal = normalize(normalMatrix * nrm);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    float a = vAlpha;
    vec3 col = vColour;
    #ifdef ROUND
      float r = length(vUv - 0.5);
      float aa = fwidth(r);
      a *= 1.0 - smoothstep(0.5 - aa, 0.5, r);
    #endif
    #ifdef LIT
      float diffuse = max(dot(normalize(vNormal), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
      col *= 0.35 + 0.65 * diffuse;
    #endif
    if (a <= 0.0) discard;
    gl_FragColor = vec4(col, a);
  }
`;

function uniformScale(m: Pick<Mapping, 'scale' | 'steps'>, domain: readonly [number, number], target: Vector4): void {
  target.set(domain[0], domain[1], SCALE_CODE[m.scale], m.steps);
}

/**
 * resolveDomain memoised on the inputs that affect it. apply() runs every frame for a
 * modulated layer, and an auto log domain scans every row, so recompute only on change.
 */
function domainMemo(data: ChannelData): (m: Mapping | ColourMapping) => readonly [number, number] {
  let scale: ScaleType | null = null;
  let d0 = NaN;
  let d1 = NaN;
  let auto = false;
  let result: readonly [number, number] = [0, 1];
  return (m) => {
    const isAuto = m.domain === null;
    const a = m.domain?.[0] ?? NaN;
    const b = m.domain?.[1] ?? NaN;
    if (m.scale !== scale || isAuto !== auto || (!isAuto && (a !== d0 || b !== d1))) {
      scale = m.scale;
      auto = isAuto;
      d0 = a;
      d1 = b;
      result = resolveDomain(m, data);
    }
    return result;
  };
}

const DEG = Math.PI / 180;

export function createInstancer(layer: InstancerLayer, source: InstancerData, cameraMode: '2d' | '3d'): InstancerInstance {
  const data: InstanceData = buildInstanceData(layer, source.table, source.cadences, source.calendars);
  const n = data.count;
  const channelNames = Object.keys(data.channels) as ChannelName[];
  const domains = new Map<ChannelName, (m: Mapping | ColourMapping) => readonly [number, number]>();
  for (const name of channelNames) domains.set(name, domainMemo(data.channels[name]!));
  const hasOpacityChannel = channelNames.includes('opacity');

  const component = (name: ChannelName): Float32Array | null => data.channels[name]?.values ?? null;
  const textures = [
    packTexture(n, [data.t, data.yearIndex, data.dayOfYear, null]),
    packTexture(n, [component('y'), component('z'), component('height'), component('size')]),
    packTexture(n, [component('rotation'), component('opacity'), component('colour'), null]),
  ] as const;

  const base = baseGeometry(layer.primitive); // only its attributes are used
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of ['position', 'normal', 'uv']) {
    const a = base.getAttribute(name);
    if (a) geometry.setAttribute(name, a);
  }
  geometry.instanceCount = 0;

  const defines: Record<string, string> = {};
  if (data.yearIndex) defines.CALENDAR = '';
  if (layer.primitive === 'point') defines.ROUND = '';
  if (layer.primitive === 'box' || layer.primitive === 'sphere') defines.LIT = '';

  const colourData = data.channels.colour;
  const uniforms: Record<string, IUniform> = {
    uData0: { value: textures[0] },
    uData1: { value: textures[1] },
    uData2: { value: textures[2] },
    uArrangement: { value: 0 },
    uOrigin: { value: new Vector3() },
    uStep: { value: new Vector3() },
    uGridColumns: { value: 1 },
    uCell: { value: new Vector2() },
    uRadius: { value: 0 },
    uAngleStep: { value: 0 },
    uRadiusStep: { value: 0 },
    uFirstRow: { value: 0 },
    uVisibleRows: { value: 0 },
    uRowCount: { value: n },
    uTStart: { value: 0 },
    uSize: { value: new Vector3() },
    uHeightAlongZ: { value: 0 },
    uColour: { value: new Color() },
    uOpacity: { value: 1 },
    uReverse: { value: 0 },
    uColourByClone: { value: 0 },
    uRamp: { value: colourData && colourData.categories > 0 ? paletteTexture() : rampTexture(layer.channels.colour.ramp) },
    uClones: { value: 1 },
    uClonePosition: { value: new Vector3() },
    uCloneRotation: { value: new Vector3() },
    uCloneScale: { value: new Vector3() },
    uCloneOrbit: { value: new Vector3() },
    uCloneFade: { value: 1 },
    uDataStep: { value: 0 },
    uPivot: { value: new Vector3() },
  };
  for (const ch of CHANNELS) {
    if (!data.channels[ch.name]) continue;
    defines[ch.define] = '';
    uniforms[`uScale${ch.suffix}`] = { value: new Vector4() };
    if (ch.name !== 'colour') uniforms[`uRange${ch.suffix}`] = { value: new Vector3() };
  }
  if (colourData) uniforms.uCategories = { value: colourData.categories };

  const material = new ShaderMaterial({ vertexShader, fragmentShader, defines, uniforms, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = layer.name;

  const v3 = (name: string) => uniforms[name]!.value as Vector3;
  const v2 = (name: string) => uniforms[name]!.value as Vector2;
  const set = (name: string, value: number) => {
    uniforms[name]!.value = value;
  };

  function apply(next: InstancerLayer, mode: '2d' | '3d'): void {
    set('uArrangement', ARRANGEMENT_CODE[next.arrangement]);
    v3('uOrigin').fromArray(next.origin);
    v3('uStep').fromArray(next.step);
    set('uGridColumns', Math.max(1, next.gridColumns));
    v2('uCell').fromArray(next.cell);
    set('uRadius', next.radius);
    set('uAngleStep', next.angleStep);
    set('uRadiusStep', next.radiusStep);

    const lo = Math.min(next.rows[0], next.rows[1]);
    const hi = Math.max(next.rows[0], next.rows[1]);
    const first = Math.max(0, Math.floor(lo * n));
    const last = Math.min(n - 1, Math.ceil(hi * n) - 1);
    const visible = Math.max(0, last - first + 1);
    const cl = next.cloner;
    // Never issue more than MAX_DRAWN instances; extra clones are dropped from the far end.
    const clones = visible > 0 ? Math.max(1, Math.min(cl.count, Math.floor(MAX_DRAWN / visible))) : 1;
    set('uFirstRow', first);
    set('uVisibleRows', visible);
    set('uClones', clones);
    geometry.instanceCount = visible * clones;
    set('uTStart', next.followRange && next.arrangement !== 'calendar' ? firstDefinedT(data.t, first) : 0);

    v3('uClonePosition').fromArray(cl.position);
    v3('uCloneRotation').set(cl.rotation[0] * DEG, cl.rotation[1] * DEG, cl.rotation[2] * DEG);
    v3('uCloneScale').fromArray(cl.scale);
    v3('uCloneOrbit').set(cl.orbit[0] * DEG, cl.orbit[1] * DEG, cl.orbit[2] * DEG);
    set('uCloneFade', cl.fade);
    set('uDataStep', cl.dataStep);
    set('uColourByClone', cl.colourByClone ? 1 : 0);
    v3('uPivot').fromArray(next.transform.pivot);

    v3('uSize').fromArray(next.size);
    set('uHeightAlongZ', next.heightAxis === 'z' ? 1 : 0);
    (uniforms.uColour!.value as Color).set(next.colour);
    set('uOpacity', next.opacity);

    for (const ch of CHANNELS) {
      const d = data.channels[ch.name];
      if (!d) continue;
      if (ch.name === 'colour') {
        uniformScale(next.channels.colour, domains.get('colour')!(next.channels.colour), uniforms.uScaleColour!.value as Vector4);
        continue;
      }
      const m = next.channels[ch.name as Exclude<ChannelName, 'colour'>];
      uniformScale(m, domains.get(ch.name)!(m), uniforms[`uScale${ch.suffix}`]!.value as Vector4);
      v3(`uRange${ch.suffix}`).set(m.range[0], m.range[1], m.clamp ? 1 : 0);
    }
    const cm = next.channels.colour;
    set('uReverse', cm.reverse ? 1 : 0);
    if (!colourData || colourData.categories === 0) uniforms.uRamp!.value = rampTexture(cm.ramp);

    const additive = next.blend === 'additive';
    const translucent =
      additive || next.opacity < 1 || next.primitive === 'point' || hasOpacityChannel || (clones > 1 && cl.fade < 1);
    material.transparent = translucent;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    // 2D layers sit on one plane, so depth testing would only cause z-fighting; draw order
    // (layer order, then clone and row order) decides what is on top.
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
    mesh.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: mesh,
    apply,
    update(_ctx: FrameContext) {
      // Static between applies; modulators drive it through apply().
    },
    dispose() {
      // The base geometry's buffers belong to `geometry` now; disposing it frees them.
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

