import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedBufferAttribute,
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
import type { Table } from '../../../data/columns.ts';
import { binDensity, blurDensity, densityDomain, gaussianKernel, gridMax, prepareDensity } from '../../../data/density-data.ts';
import { LayerDataError } from '../../../data/instance-data.ts';
import { rowRange } from '../../../data/line-data.ts';
import { MAX_DENSITY_CELLS, type DensityLayer, type ScaleType } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { rampTexture } from './ramps.ts';

/**
 * Density map layer: rows are counted into bins on the CPU (density-data.ts) and smoothed.
 *
 * Flat: the bins are uploaded as one R32F texture and one quad draws them, the fragment shader
 * interpolating between bin centres, applying the scale and the ramp, and dropping bins below the
 * threshold (soft-edged, so the field fades out rather than stepping).
 *
 * Dots: every bin with a count is one instance of a camera-facing soft dot. Each instance holds
 * its bin (i, j, k) and count; the vertex shader places it (origin + bin centre × size, and in
 * depth either its z bin or its count × depth), scales it by the colour scale and hides it below
 * the threshold, so position, size, depth, scale, domain and threshold are all uniforms. With a z
 * column the bins are 3D.
 *
 * Counting is redone only when its inputs change: bins, smoothing or the domains re-count every
 * row (for the auto colour domain) and the visible rows; a new row range (a data playhead)
 * re-counts the visible rows only. Buffers are reused, so a sweeping playhead allocates nothing.
 * At 100k rows and 320 × 160 bins with smoothing 1.5 a re-count measured 2.7 ms (Node, this
 * laptop's CPU); 3D bins cost more (cells × taps × 3 passes). If that proves slow, a build-up
 * could count only the new rows, or the counting can move to the GPU.
 */

export interface DensitySourceData {
  table: Table;
}

export interface DensityInstance extends LayerInstance {
  apply(layer: DensityLayer, cameraMode: '2d' | '3d'): void;
}

const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };
/** Most dots drawn (bins with a count); the rest are left out. */
const MAX_DOTS = 500_000;

const NORM_GLSL = /* glsl */ `
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
`;

const flatVertex = /* glsl */ `
  uniform vec3 uOrigin;
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    vec3 p = uOrigin + vec3(position.x * uSize.x, position.y * uSize.y, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const flatFragment = /* glsl */ `
  uniform sampler2D uData;
  uniform vec2 uBins;
  uniform vec4 uScale;
  uniform float uReverse;
  uniform float uThreshold;
  uniform sampler2D uRamp;
  uniform float uOpacity;
  varying vec2 vUv;
  ${NORM_GLSL}
  float bin(ivec2 c) {
    c = clamp(c, ivec2(0), ivec2(uBins) - 1);
    return texelFetch(uData, c, 0).r;
  }

  void main() {
    // Bilinear between bin centres (float textures need not filter).
    vec2 f = vUv * uBins - 0.5;
    ivec2 c = ivec2(floor(f));
    vec2 t = fract(f);
    float v = mix(mix(bin(c), bin(c + ivec2(1, 0)), t.x), mix(bin(c + ivec2(0, 1)), bin(c + ivec2(1, 1)), t.x), t.y);
    if (v <= 1.0e-6) discard;
    float n = norm(v, uScale);
    float edge = smoothstep(uThreshold, uThreshold + 0.04, n);
    if (edge <= 0.0) discard;
    if (uReverse > 0.5) n = 1.0 - n;
    gl_FragColor = vec4(texture2D(uRamp, vec2(n, 0.5)).rgb, uOpacity * edge);
  }
`;

const dotVertex = /* glsl */ `
  attribute vec4 aDot;      // bin i, j, k and count
  uniform vec3 uOrigin;
  uniform vec2 uSize;
  uniform vec3 uBins3;      // bins across, down, deep
  uniform float uDepth;
  uniform float uHasZ;      // 1: depth from the z bin, 0: from the count
  uniform float uDotSize;
  uniform float uJitter;
  uniform vec4 uScale;
  uniform float uThreshold;
  varying vec2 vCorner;
  varying float vN;
  varying float vEdge;
  ${NORM_GLSL}
  // Fixed pseudo-random offsets per bin, -0.5..0.5 on each axis.
  vec3 hash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) - 0.5;
  }

  void main() {
    float n = norm(aDot.w, uScale);
    float edge = smoothstep(uThreshold, uThreshold + 0.04, n);
    if (edge <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // Within its own bin only (depth too, with a z column).
    vec3 j = hash3(aDot.xyz + 1.0) * uJitter;
    vec3 p = uOrigin + vec3((aDot.x + 0.5 + j.x) / uBins3.x * uSize.x, (aDot.y + 0.5 + j.y) / uBins3.y * uSize.y, 0.0);
    p.z += uHasZ > 0.5 ? (aDot.z + 0.5 + j.z) / uBins3.z * uDepth : n * uDepth;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Camera-facing: grow in view space, so dots keep their size and get smaller with distance.
    mv.xy += position.xy * uDotSize * (0.35 + 0.65 * n);
    gl_Position = projectionMatrix * mv;
    vCorner = position.xy * 2.0;
    vN = n;
    vEdge = edge;
  }
`;

const dotFragment = /* glsl */ `
  uniform float uReverse;
  uniform sampler2D uRamp;
  uniform float uOpacity;
  varying vec2 vCorner;
  varying float vN;
  varying float vEdge;

  void main() {
    float r2 = dot(vCorner, vCorner);
    if (r2 > 1.0) discard;
    float soft = (1.0 - r2) * (1.0 - r2);
    float n = uReverse > 0.5 ? 1.0 - vN : vN;
    gl_FragColor = vec4(texture2D(uRamp, vec2(n, 0.5)).rgb, uOpacity * vEdge * soft);
  }
`;

export function createDensity(layer: DensityLayer, source: DensitySourceData, cameraMode: '2d' | '3d'): DensityInstance {
  const src = prepareDensity(layer, source.table);
  const root = new Group();
  root.name = layer.name;
  if (!src) {
    // Not configured yet (x or y column missing): draw nothing.
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }
  const hasZ = src.z !== null;

  let binsX = 0;
  let binsY = 0;
  let binsZ = 0;
  let grid = new Float32Array(0);
  let tmp = new Float32Array(0);
  let texture: DataTexture | null = null;
  let kernel = gaussianKernel(0);
  let kernelSigma = 0;
  /** Inputs of the last full count, and its peak (the auto colour domain's top). */
  const counted = { binsX: 0, binsY: 0, binsZ: 0, radius: NaN, x0: NaN, x1: NaN, y0: NaN, y1: NaN, z0: NaN, z1: NaN, first: -1, last: -1, dots: false };
  let autoMax = 0;

  const uniforms: Record<string, IUniform> = {
    uOrigin: { value: new Vector3() },
    uSize: { value: new Vector2() },
    uData: { value: null },
    uBins: { value: new Vector2() },
    uBins3: { value: new Vector3() },
    uDepth: { value: 0 },
    uHasZ: { value: hasZ ? 1 : 0 },
    uDotSize: { value: 10 },
    uJitter: { value: 0 },
    uScale: { value: new Vector4() },
    uReverse: { value: 0 },
    uThreshold: { value: 0 },
    uRamp: { value: rampTexture(layer.ramp) },
    uOpacity: { value: 1 },
  };

  // Flat: one quad.
  const flatGeometry = new BufferGeometry();
  flatGeometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  flatGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  const flatMaterial = new ShaderMaterial({ vertexShader: flatVertex, fragmentShader: flatFragment, uniforms, side: DoubleSide, transparent: true, depthWrite: false });
  const flat = new Mesh(flatGeometry, flatMaterial);
  flat.frustumCulled = false;
  root.add(flat);

  // Dots: one instanced quad per bin with a count.
  const dotGeometry = new InstancedBufferGeometry();
  dotGeometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  dotGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  dotGeometry.instanceCount = 0;
  let dotAttr: InstancedBufferAttribute | null = null;
  const dotMaterial = new ShaderMaterial({ vertexShader: dotVertex, fragmentShader: dotFragment, uniforms, side: DoubleSide, transparent: true, depthWrite: false });
  const dots = new Mesh(dotGeometry, dotMaterial);
  dots.frustumCulled = false;
  root.add(dots);

  function resize(bx: number, by: number, bz: number): void {
    if (bx === binsX && by === binsY && bz === binsZ) return;
    if (bx * by * bz > MAX_DENSITY_CELLS) {
      throw new LayerDataError(`${bx} × ${by} × ${bz} bins is more than ${MAX_DENSITY_CELLS.toLocaleString('en-NZ')}; use fewer bins`);
    }
    binsX = bx;
    binsY = by;
    binsZ = bz;
    grid = new Float32Array(bx * by * bz);
    tmp = new Float32Array(bx * by * bz);
    texture?.dispose();
    texture = null;
    if (bz === 1) {
      texture = new DataTexture(grid, bx, by, RedFormat, FloatType);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;
    }
    uniforms.uData!.value = texture;
    (uniforms.uBins!.value as Vector2).set(bx, by);
    (uniforms.uBins3!.value as Vector3).set(bx, by, bz);
    const capacity = Math.min(MAX_DOTS, bx * by * bz);
    if (!dotAttr || dotAttr.count < capacity) {
      dotAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      dotAttr.setUsage(DynamicDrawUsage);
      dotGeometry.setAttribute('aDot', dotAttr);
    }
  }

  function count(first: number, last: number, x: readonly [number, number], y: readonly [number, number], z: readonly [number, number]): void {
    binDensity(src!, first, last, x, y, binsX, binsY, grid, z, binsZ);
    blurDensity(grid, binsX, binsY, kernel, tmp, binsZ);
  }

  /** Bins with a count into the dot buffer (positions and sizes are worked out on the GPU). */
  function fillDots(): void {
    const attr = dotAttr!;
    const out = attr.array as Float32Array;
    const cap = attr.count;
    const plane = binsX * binsY;
    let n = 0;
    for (let c = 0; c < plane * binsZ && n < cap; c++) {
      const v = grid[c]!;
      if (v <= 1e-6) continue;
      const k = Math.floor(c / plane);
      const rest = c - k * plane;
      const j = Math.floor(rest / binsX);
      const o = n * 4;
      out[o] = rest - j * binsX;
      out[o + 1] = j;
      out[o + 2] = k;
      out[o + 3] = v;
      n++;
    }
    dotGeometry.instanceCount = n;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * 4);
    attr.needsUpdate = true;
  }

  function apply(next: DensityLayer, mode: '2d' | '3d'): void {
    const asDots = next.mode === 'dots';
    resize(next.bins[0], next.bins[1], asDots && hasZ ? next.binsZ : 1);
    if (next.radius !== kernelSigma) {
      kernelSigma = next.radius;
      kernel = gaussianKernel(next.radius);
    }
    const x = densityDomain(next.xDomain, src!.xAuto);
    const y = densityDomain(next.yDomain, src!.yAuto);
    const z = densityDomain(next.zDomain, src!.zAuto);
    const [first, last] = rowRange(next.rows, src!.rowCount);
    const c = counted;
    const shape =
      c.binsX !== binsX || c.binsY !== binsY || c.binsZ !== binsZ || c.radius !== next.radius ||
      c.x0 !== x[0] || c.x1 !== x[1] || c.y0 !== y[0] || c.y1 !== y[1] || c.z0 !== z[0] || c.z1 !== z[1];
    let refreshed = false;
    if (shape) {
      // The auto colour domain comes from every row, so colours hold while the rows sweep.
      count(0, src!.rowCount - 1, x, y, z);
      autoMax = gridMax(grid, binsX * binsY * binsZ);
      Object.assign(c, { binsX, binsY, binsZ, radius: next.radius, x0: x[0], x1: x[1], y0: y[0], y1: y[1], z0: z[0], z1: z[1], first: 0, last: src!.rowCount - 1 });
      refreshed = true;
    }
    if (shape || first !== c.first || last !== c.last) {
      if (first !== 0 || last !== src!.rowCount - 1) count(first, last, x, y, z);
      c.first = first;
      c.last = last;
      refreshed = true;
    }
    if (refreshed || asDots !== c.dots) {
      c.dots = asDots;
      if (asDots) fillDots();
      else if (texture) texture.needsUpdate = true;
    }
    flat.visible = !asDots;
    dots.visible = asDots;

    (uniforms.uOrigin!.value as Vector3).fromArray(next.origin);
    (uniforms.uSize!.value as Vector2).set(next.size[0], next.size[1]);
    uniforms.uDepth!.value = next.depth;
    uniforms.uDotSize!.value = next.dotSize;
    uniforms.uJitter!.value = next.jitter;
    const top = autoMax > 0 ? autoMax : 1;
    const domain = next.domain ?? (next.scale === 'log' ? [top / 1000, top] : [0, top]);
    (uniforms.uScale!.value as Vector4).set(domain[0], domain[1], SCALE_CODE[next.scale], next.steps);
    uniforms.uReverse!.value = next.reverse ? 1 : 0;
    uniforms.uThreshold!.value = next.threshold;
    uniforms.uRamp!.value = rampTexture(next.ramp);
    uniforms.uOpacity!.value = next.opacity;

    const additive = next.blend === 'additive';
    for (const m of [flatMaterial, dotMaterial]) {
      m.blending = additive ? AdditiveBlending : NormalBlending;
      m.depthTest = mode === '3d' && !additive;
    }
    root.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {},
    dispose() {
      flatGeometry.dispose();
      flatMaterial.dispose();
      dotGeometry.dispose();
      dotMaterial.dispose();
      texture?.dispose();
    },
  };
}
