import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import type { Table } from '../../../data/columns.ts';
import type { Cadence } from '../../../data/gaps.ts';
import { resolveDomain, type ChannelData } from '../../../data/instance-data.ts';
import { buildLineData, lineTStart, POINT_STRIDE, rowRange, type LineData } from '../../../data/line-data.ts';
import type { ColourMapping, LineLayer, Mapping, ScaleType } from '../../../shared/layer-schema.ts';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../stage.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { paletteTexture, PALETTE, rampTexture } from './ramps.ts';

/**
 * Line layer: real geometry with a width in output px, never GL lines. Each segment between
 * consecutive drawable points is one instance of a four-vertex quad. The vertex shader
 * places both ends (origin + t * step + mapped y/z, the instancer's scale maths), projects
 * them, and extrudes the quad perpendicular to the segment in screen space, so the width is
 * constant in px with the 2D and the 3D camera. The quad is lengthened by half the width at
 * each end and the fragment shader trims it to a capsule, which gives round caps and round
 * joins for free (translucent lines double-blend where neighbouring caps overlap).
 *
 * The points are uploaded once as an interleaved buffer that both ends of a segment read
 * (the end attributes are offset by one point), so rows, gap rule, domains, ranges, width
 * and colours are all uniform updates.
 */

export interface LineSource {
  table: Table;
  cadences: Record<string, Cadence>;
}

export interface LineInstance extends LayerInstance {
  apply(layer: LineLayer, cameraMode: '2d' | '3d'): void;
}

const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };

const vertexShader = /* glsl */ `
  // A: start point, B: end point. xyzw = t, source row, raw y, raw z; c = raw colour value.
  attribute vec4 aA;
  attribute float aAc;
  attribute vec4 aB;
  attribute float aBc;

  uniform vec3 uOrigin;
  uniform vec3 uStep;
  uniform float uTStart;
  uniform vec2 uRows;
  uniform float uBreak;
  uniform float uGapFactor;
  uniform float uTimeMode;
  uniform float uWidth;
  uniform vec2 uResolution;
  #ifdef CH_Y
    uniform vec4 uScaleY; uniform vec3 uRangeY;
  #endif
  #ifdef CH_Z
    uniform vec4 uScaleZ; uniform vec3 uRangeZ;
  #endif
  #ifdef CH_COLOUR
    uniform vec4 uScaleColour;
    uniform float uCategories;
    uniform float uReverse;
  #endif

  // xy: (along, across) px x w, z: w, w: segment length px (perspective-corrected in the fragment).
  varying vec4 vLocal;
  // Colour ramp coordinate at the start and end.
  varying vec2 vRamp;

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

  vec3 place(vec4 p) {
    vec3 pos = uOrigin + (p.x - uTStart) * uStep;
    #ifdef CH_Y
      pos.y += mapChannel(p.z, uScaleY, uRangeY);
    #endif
    #ifdef CH_Z
      pos.z += mapChannel(p.w, uScaleZ, uRangeZ);
    #endif
    return pos;
  }

  float rampCoord(float c) {
    #ifdef CH_COLOUR
      if (uCategories > 0.0) return (mod(c, ${PALETTE.length.toFixed(1)}) + 0.5) / ${PALETTE.length.toFixed(1)};
      float n = norm(c, uScaleColour, 1.0);
      return uReverse > 0.5 ? 1.0 - n : n;
    #else
      return 0.0;
    #endif
  }

  void hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec4(0.0, 0.0, 1.0, 0.0);
    vRamp = vec2(0.0);
  }

  void main() {
    // Rows range: both ends must be visible. Gap rule: mirrors segmentBroken() in line-data.ts.
    if (aA.y < uRows.x || aB.y > uRows.y) { hide(); return; }
    if (uBreak > 0.5 && (aB.y - aA.y > 1.5 || (uTimeMode > 0.5 && aB.x - aA.x > uGapFactor))) { hide(); return; }

    vec4 v0 = modelViewMatrix * vec4(place(aA), 1.0);
    vec4 v1 = modelViewMatrix * vec4(place(aB), 1.0);
    if (projectionMatrix[2][3] == -1.0) {
      // Perspective: trim the segment to the near plane so neither end projects from behind.
      float near = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
      float zn = -near * 1.001;
      if (v0.z > zn && v1.z > zn) { hide(); return; }
      if (v0.z > zn) v0.xyz = mix(v0.xyz, v1.xyz, (zn - v0.z) / (v1.z - v0.z));
      else if (v1.z > zn) v1.xyz = mix(v1.xyz, v0.xyz, (zn - v1.z) / (v0.z - v1.z));
    }
    vec4 c0 = projectionMatrix * v0;
    vec4 c1 = projectionMatrix * v1;
    vec2 halfRes = 0.5 * uResolution;
    vec2 s0 = c0.xy / c0.w * halfRes;
    vec2 s1 = c1.xy / c1.w * halfRes;
    vec2 d = s1 - s0;
    float len = length(d);
    vec2 dir = len > 1.0e-4 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);

    // One extra px all round leaves room for the anti-aliased edge.
    float reach = 0.5 * uWidth + 1.0;
    bool atEnd = position.x > 0.5;
    float along = atEnd ? len + reach : -reach;
    float across = position.y * reach;
    vec2 s = s0 + dir * along + nrm * across;
    vec4 c = atEnd ? c1 : c0;
    gl_Position = vec4(s / halfRes * c.w, c.z, c.w);

    vLocal = vec4(vec2(along, across) * c.w, c.w, len);
    vRamp = vec2(rampCoord(aAc), rampCoord(aBc));
    #ifdef CH_COLOUR
      if (uCategories > 0.0) vRamp.y = vRamp.x; // codes do not interpolate
    #endif
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform float uWidth;
  #ifdef CH_COLOUR
    uniform sampler2D uRamp;
  #endif
  varying vec4 vLocal;
  varying vec2 vRamp;

  void main() {
    vec2 p = vLocal.xy / vLocal.z;
    float len = vLocal.w;
    // Distance from the segment (a capsule: round caps make round joins).
    float d = p.x < 0.0 ? length(p) : (p.x > len ? length(vec2(p.x - len, p.y)) : abs(p.y));
    float a = clamp(0.5 * uWidth - d + 0.5, 0.0, 1.0) * uOpacity;
    if (a <= 0.0) discard;
    vec3 colour = uColour;
    #ifdef CH_COLOUR
      float f = len > 0.0 ? clamp(p.x / len, 0.0, 1.0) : 0.0;
      colour = texture2D(uRamp, vec2(mix(vRamp.x, vRamp.y, f), 0.5)).rgb;
    #endif
    gl_FragColor = vec4(colour, a);
  }
`;

/** resolveDomain memoised on the inputs that affect it (apply runs per frame when modulated). */
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

function setScale(target: Vector4, m: Pick<Mapping, 'scale' | 'steps'>, domain: readonly [number, number]): void {
  target.set(domain[0], domain[1], SCALE_CODE[m.scale], m.steps);
}

export function createLine(layer: LineLayer, source: LineSource, cameraMode: '2d' | '3d'): LineInstance {
  const data: LineData = buildLineData(layer, source.table, source.cadences);
  const root = new Group();
  root.name = layer.name;
  const segments = Math.max(0, data.count - 1);

  if (segments === 0) {
    // Nothing to draw (not configured yet, or fewer than two points).
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }

  // Quad corners: x = 0 at the start, 1 at the end; y = side (-1 / +1).
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const buffer = new InstancedInterleavedBuffer(data.points, POINT_STRIDE, 1);
  geometry.setAttribute('aA', new InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute('aAc', new InterleavedBufferAttribute(buffer, 1, 4));
  // The end of segment i is point i + 1: the same buffer, one point further on.
  geometry.setAttribute('aB', new InterleavedBufferAttribute(buffer, 4, POINT_STRIDE));
  geometry.setAttribute('aBc', new InterleavedBufferAttribute(buffer, 1, POINT_STRIDE + 4));
  geometry.instanceCount = segments;

  const defines: Record<string, string> = {};
  const uniforms: Record<string, IUniform> = {
    uOrigin: { value: new Vector3() },
    uStep: { value: new Vector3() },
    uTStart: { value: 0 },
    uRows: { value: new Vector2() },
    uBreak: { value: 0 },
    uGapFactor: { value: 1.5 },
    uTimeMode: { value: data.timeMode ? 1 : 0 },
    uWidth: { value: 2 },
    uResolution: { value: new Vector2(OUTPUT_WIDTH, OUTPUT_HEIGHT) },
    uColour: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const yDomain = data.y ? domainMemo(data.y) : null;
  const zDomain = data.z ? domainMemo(data.z) : null;
  const colourDomain = data.colour ? domainMemo(data.colour) : null;
  if (data.y) {
    defines.CH_Y = '';
    uniforms.uScaleY = { value: new Vector4() };
    uniforms.uRangeY = { value: new Vector3() };
  }
  if (data.z) {
    defines.CH_Z = '';
    uniforms.uScaleZ = { value: new Vector4() };
    uniforms.uRangeZ = { value: new Vector3() };
  }
  const categories = data.colour?.categories ?? 0;
  if (data.colour) {
    defines.CH_COLOUR = '';
    uniforms.uScaleColour = { value: new Vector4() };
    uniforms.uCategories = { value: categories };
    uniforms.uReverse = { value: 0 };
    uniforms.uRamp = { value: categories > 0 ? paletteTexture() : rampTexture(layer.colourMap.ramp) };
  }

  const material = new ShaderMaterial({ vertexShader, fragmentShader, defines, uniforms, transparent: true, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  root.add(mesh);

  const vec3u = (name: string) => uniforms[name]!.value as Vector3;

  function apply(next: LineLayer, mode: '2d' | '3d'): void {
    vec3u('uOrigin').fromArray(next.origin);
    vec3u('uStep').fromArray(next.step);
    const [first, last] = rowRange(next.rows, data.rowCount);
    (uniforms.uRows!.value as Vector2).set(first, last);
    uniforms.uTStart!.value = lineTStart(data, next.followRange, first);
    uniforms.uBreak!.value = next.breakOnGaps ? 1 : 0;
    uniforms.uGapFactor!.value = next.gapFactor;
    uniforms.uWidth!.value = next.width;
    (uniforms.uColour!.value as Color).set(next.colour);
    uniforms.uOpacity!.value = next.opacity;
    if (yDomain) {
      setScale(uniforms.uScaleY!.value as Vector4, next.y, yDomain(next.y));
      vec3u('uRangeY').set(next.y.range[0], next.y.range[1], next.y.clamp ? 1 : 0);
    }
    if (zDomain) {
      setScale(uniforms.uScaleZ!.value as Vector4, next.z, zDomain(next.z));
      vec3u('uRangeZ').set(next.z.range[0], next.z.range[1], next.z.clamp ? 1 : 0);
    }
    if (colourDomain) {
      setScale(uniforms.uScaleColour!.value as Vector4, next.colourMap, colourDomain(next.colourMap));
      uniforms.uReverse!.value = next.colourMap.reverse ? 1 : 0;
      if (categories === 0) uniforms.uRamp!.value = rampTexture(next.colourMap.ramp);
    }

    // Same depth rules as the instancer: in 2D draw order decides; in 3D test depth, and
    // write it only when opaque. Lines always blend (anti-aliased edges).
    const additive = next.blend === 'additive';
    const translucent = additive || next.opacity < 1;
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
    },
  };
}
