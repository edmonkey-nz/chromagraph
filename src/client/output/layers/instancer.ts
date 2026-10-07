import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
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
import type { ColourMapping, InstancerLayer, Mapping, NumericChannel, Primitive, ScaleType } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { paletteTexture, PALETTE, rampTexture } from './ramps.ts';

/**
 * Instancer layer: one instance per data row in a single instanced draw call. Positions,
 * sizes and colours are computed in the vertex shader from per-instance attributes (the
 * raw column values) and uniforms (arrangement, domains, ranges), so editing a mapping's
 * domain, range or scale is a uniform update — only changing which columns are used
 * rebuilds the instance arrays.
 *
 * (InstancedBufferGeometry rather than InstancedMesh: no per-instance matrices are needed
 * when the shader places every instance.)
 */

export interface InstancerData {
  table: Table;
  cadences: Record<string, Cadence>;
  calendars: Record<string, CalendarFields>;
}

export interface InstancerInstance extends LayerInstance {
  apply(layer: InstancerLayer, cameraMode: '2d' | '3d'): void;
}

const ARRANGEMENT_CODE = { linear: 0, grid: 1, calendar: 2, radial: 3, spiral: 4 } as const;
const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };

const NUMERIC: { name: NumericChannel; define: string; attr: string }[] = [
  { name: 'y', define: 'CH_Y', attr: 'aChY' },
  { name: 'z', define: 'CH_Z', attr: 'aChZ' },
  { name: 'height', define: 'CH_HEIGHT', attr: 'aChHeight' },
  { name: 'size', define: 'CH_SIZE', attr: 'aChSize' },
  { name: 'rotation', define: 'CH_ROTATION', attr: 'aChRotation' },
  { name: 'opacity', define: 'CH_OPACITY', attr: 'aChOpacity' },
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

const vertexShader = /* glsl */ `
  #define MISSING_TEST -1.0e29

  attribute float aT;
  attribute float aRow;
  #ifdef CALENDAR
    attribute float aYear;
    attribute float aDay;
  #endif
  #ifdef CH_Y
    attribute float aChY;
    uniform vec4 uScaleY; uniform vec3 uRangeY;
  #endif
  #ifdef CH_Z
    attribute float aChZ;
    uniform vec4 uScaleZ; uniform vec3 uRangeZ;
  #endif
  #ifdef CH_HEIGHT
    attribute float aChHeight;
    uniform vec4 uScaleHeight; uniform vec3 uRangeHeight;
  #endif
  #ifdef CH_SIZE
    attribute float aChSize;
    uniform vec4 uScaleSize; uniform vec3 uRangeSize;
  #endif
  #ifdef CH_ROTATION
    attribute float aChRotation;
    uniform vec4 uScaleRotation; uniform vec3 uRangeRotation;
  #endif
  #ifdef CH_OPACITY
    attribute float aChOpacity;
    uniform vec4 uScaleOpacity; uniform vec3 uRangeOpacity;
  #endif
  #ifdef CH_COLOUR
    attribute float aChColour;
    uniform vec4 uScaleColour;
    uniform float uCategories;
    uniform float uReverse;
    uniform sampler2D uRamp;
  #endif

  uniform int uArrangement;
  uniform vec3 uOrigin;
  uniform vec3 uStep;
  uniform float uGridColumns;
  uniform vec2 uCell;
  uniform float uRadius;
  uniform float uAngleStep;
  uniform float uRadiusStep;
  uniform vec2 uRows;
  uniform float uTStart;
  uniform vec3 uSize;
  uniform float uHeightAlongZ;
  uniform vec3 uColour;
  uniform float uOpacity;

  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec3 vNormal;

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

  void main() {
    bool hidden = aRow < uRows.x || aRow > uRows.y || aT < MISSING_TEST;
    #ifdef CALENDAR
      hidden = hidden || aYear < MISSING_TEST;
    #endif
    #ifdef CH_Y
      hidden = hidden || aChY < MISSING_TEST;
    #endif
    #ifdef CH_Z
      hidden = hidden || aChZ < MISSING_TEST;
    #endif
    #ifdef CH_HEIGHT
      hidden = hidden || aChHeight < MISSING_TEST;
    #endif
    #ifdef CH_SIZE
      hidden = hidden || aChSize < MISSING_TEST;
    #endif
    #ifdef CH_ROTATION
      hidden = hidden || aChRotation < MISSING_TEST;
    #endif
    #ifdef CH_OPACITY
      hidden = hidden || aChOpacity < MISSING_TEST;
    #endif
    #ifdef CH_COLOUR
      hidden = hidden || aChColour < MISSING_TEST;
    #endif
    if (hidden) {
      // Missing data is not drawn (never drawn as zero). Park the vertex outside clip space.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      vColour = vec3(0.0);
      vUv = vec2(0.0);
      vNormal = vec3(0.0, 0.0, 1.0);
      return;
    }

    float t = aT - uTStart;
    vec3 p;
    if (uArrangement == 0) {
      p = uOrigin + t * uStep;
    } else if (uArrangement == 1) {
      float col = mod(t, uGridColumns);
      float row = floor(t / uGridColumns);
      p = uOrigin + vec3(col * uCell.x, -row * uCell.y, 0.0);
    } else if (uArrangement == 2) {
      #ifdef CALENDAR
        p = uOrigin + vec3(aDay * uCell.x, -aYear * uCell.y, 0.0);
      #else
        p = uOrigin;
      #endif
    } else {
      float ang = radians(t * uAngleStep);
      float r = uRadius + (uArrangement == 4 ? t * uRadiusStep : 0.0);
      p = uOrigin + vec3(sin(ang) * r, cos(ang) * r, 0.0);
    }

    vec3 size = uSize;
    float rot = 0.0;
    #ifdef CH_HEIGHT
      size.y = mapChannel(aChHeight, uScaleHeight, uRangeHeight);
    #endif
    #ifdef CH_SIZE
      size *= mapChannel(aChSize, uScaleSize, uRangeSize);
    #endif
    #ifdef CH_ROTATION
      rot = radians(mapChannel(aChRotation, uScaleRotation, uRangeRotation));
    #endif
    #ifdef CH_Y
      p.y += mapChannel(aChY, uScaleY, uRangeY);
    #endif
    #ifdef CH_Z
      p.z += mapChannel(aChZ, uScaleZ, uRangeZ);
    #endif

    // Height along z: swap the primitive's y and z (its base stays at its origin).
    vec3 pos = uHeightAlongZ > 0.5 ? position.xzy : position;
    vec3 nrm = uHeightAlongZ > 0.5 ? normal.xzy : normal;
    vec3 local = pos * (uHeightAlongZ > 0.5 ? size.xzy : size);
    float c = cos(rot);
    float s = sin(rot);
    local.xy = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p + local, 1.0);

    vec3 colour = uColour;
    #ifdef CH_COLOUR
      float cn;
      if (uCategories > 0.0) {
        cn = (mod(aChColour, ${PALETTE.length.toFixed(1)}) + 0.5) / ${PALETTE.length.toFixed(1)};
      } else {
        cn = norm(aChColour, uScaleColour, 1.0);
        if (uReverse > 0.5) cn = 1.0 - cn;
      }
      colour = texture2D(uRamp, vec2(cn, 0.5)).rgb;
    #endif
    float alpha = uOpacity;
    #ifdef CH_OPACITY
      alpha *= clamp(mapChannel(aChOpacity, uScaleOpacity, uRangeOpacity), 0.0, 1.0);
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

export function createInstancer(layer: InstancerLayer, source: InstancerData, cameraMode: '2d' | '3d'): InstancerInstance {
  const data: InstanceData = buildInstanceData(layer, source.table, source.cadences, source.calendars);
  const channelNames = Object.keys(data.channels) as ChannelName[];
  const domains = new Map<ChannelName, (m: Mapping | ColourMapping) => readonly [number, number]>();
  for (const name of channelNames) domains.set(name, domainMemo(data.channels[name]!));
  const translucentChannels = channelNames.includes('opacity');

  const base = baseGeometry(layer.primitive); // only its attributes are used
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of ['position', 'normal', 'uv']) {
    const a = base.getAttribute(name);
    if (a) geometry.setAttribute(name, a);
  }
  geometry.instanceCount = data.count;
  geometry.setAttribute('aT', new InstancedBufferAttribute(data.t, 1));
  const rows = new Float32Array(data.count);
  for (let i = 0; i < rows.length; i++) rows[i] = i;
  geometry.setAttribute('aRow', new InstancedBufferAttribute(rows, 1));
  if (data.yearIndex && data.dayOfYear) {
    geometry.setAttribute('aYear', new InstancedBufferAttribute(data.yearIndex, 1));
    geometry.setAttribute('aDay', new InstancedBufferAttribute(data.dayOfYear, 1));
  }

  const defines: Record<string, string> = {};
  if (data.yearIndex) defines.CALENDAR = '';
  if (layer.primitive === 'point') defines.ROUND = '';
  if (layer.primitive === 'box' || layer.primitive === 'sphere') defines.LIT = '';

  const uniforms: Record<string, IUniform> = {
    uArrangement: { value: 0 },
    uOrigin: { value: new Vector3() },
    uStep: { value: new Vector3() },
    uGridColumns: { value: 1 },
    uCell: { value: new Vector2() },
    uRadius: { value: 0 },
    uAngleStep: { value: 0 },
    uRadiusStep: { value: 0 },
    uRows: { value: new Vector2() },
    uTStart: { value: 0 },
    uSize: { value: new Vector3() },
    uHeightAlongZ: { value: 0 },
    uColour: { value: new Color() },
    uOpacity: { value: 1 },
  };
  for (const ch of NUMERIC) {
    const d = data.channels[ch.name];
    if (!d) continue;
    defines[ch.define] = '';
    geometry.setAttribute(ch.attr, new InstancedBufferAttribute(d.values, 1));
    const suffix = ch.attr.slice(3); // aChHeight -> Height
    uniforms[`uScale${suffix}`] = { value: new Vector4() };
    uniforms[`uRange${suffix}`] = { value: new Vector3() };
  }
  const colourData = data.channels.colour;
  if (colourData) {
    defines.CH_COLOUR = '';
    geometry.setAttribute('aChColour', new InstancedBufferAttribute(colourData.values, 1));
    uniforms.uScaleColour = { value: new Vector4() };
    uniforms.uCategories = { value: colourData.categories };
    uniforms.uReverse = { value: 0 };
    uniforms.uRamp = { value: colourData.categories > 0 ? paletteTexture() : rampTexture(layer.channels.colour.ramp) };
  }

  const material = new ShaderMaterial({ vertexShader, fragmentShader, defines, uniforms, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = layer.name;

  const vec3u = (name: string) => uniforms[name]!.value as Vector3;
  const vec2u = (name: string) => uniforms[name]!.value as Vector2;

  function apply(next: InstancerLayer, mode: '2d' | '3d'): void {
    uniforms.uArrangement!.value = ARRANGEMENT_CODE[next.arrangement];
    vec3u('uOrigin').fromArray(next.origin);
    vec3u('uStep').fromArray(next.step);
    uniforms.uGridColumns!.value = Math.max(1, next.gridColumns);
    vec2u('uCell').fromArray(next.cell);
    uniforms.uRadius!.value = next.radius;
    uniforms.uAngleStep!.value = next.angleStep;
    uniforms.uRadiusStep!.value = next.radiusStep;

    const n = data.count;
    const first = Math.max(0, Math.floor(Math.min(next.rows[0], next.rows[1]) * n));
    const last = Math.min(n - 1, Math.ceil(Math.max(next.rows[0], next.rows[1]) * n) - 1);
    vec2u('uRows').set(first, last);
    uniforms.uTStart!.value = next.followRange && next.arrangement !== 'calendar' ? firstDefinedT(data.t, first) : 0;

    vec3u('uSize').fromArray(next.size);
    uniforms.uHeightAlongZ!.value = next.heightAxis === 'z' ? 1 : 0;
    (uniforms.uColour!.value as Color).set(next.colour);
    uniforms.uOpacity!.value = next.opacity;

    for (const ch of NUMERIC) {
      const d = data.channels[ch.name];
      if (!d) continue;
      const m = next.channels[ch.name];
      const suffix = ch.attr.slice(3);
      uniformScale(m, domains.get(ch.name)!(m), uniforms[`uScale${suffix}`]!.value as Vector4);
      (uniforms[`uRange${suffix}`]!.value as Vector3).set(m.range[0], m.range[1], m.clamp ? 1 : 0);
    }
    if (colourData) {
      const m = next.channels.colour;
      uniformScale(m, domains.get('colour')!(m), uniforms.uScaleColour!.value as Vector4);
      uniforms.uReverse!.value = m.reverse ? 1 : 0;
      if (colourData.categories === 0) uniforms.uRamp!.value = rampTexture(m.ramp);
    }

    const additive = next.blend === 'additive';
    const translucent =
      additive || next.opacity < 1 || next.primitive === 'point' || translucentChannels;
    material.transparent = translucent;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    // 2D layers sit on one plane, so depth testing would only cause z-fighting; draw order
    // (layer order, then row order) decides what is on top.
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
    mesh.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: mesh,
    apply,
    update(_ctx: FrameContext) {
      // Static for now; phase 4 modulators will drive uniforms from here.
    },
    dispose() {
      // The base geometry's buffers belong to `geometry` now; disposing it frees them.
      geometry.dispose();
      material.dispose();
    },
  };
}
