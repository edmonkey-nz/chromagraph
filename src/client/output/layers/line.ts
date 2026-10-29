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
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import type { Table } from '../../../data/columns.ts';
import type { CalendarFields } from '../../../data/calendar.ts';
import type { Cadence } from '../../../data/gaps.ts';
import { resolveDomain, type ChannelData } from '../../../data/instance-data.ts';
import {
  buildLineData,
  lineCloneCount,
  lineTStart,
  POINT_STRIDE,
  P_ROW,
  P_T,
  rowRange,
  segmentRange,
  type LineData,
} from '../../../data/line-data.ts';
import type { ColourMapping, LineLayer, Mapping, ScaleType } from '../../../shared/layer-schema.ts';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../stage.ts';
import { createLineAxes } from './line-axes-view.ts';
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
 * Data lives in two RGBA32F data textures read with texelFetch, uploaded once:
 *   points  t, source row per drawable point (see line-data.ts)
 *   values  raw y, z, colour per table row (MISSING where missing), for the cloner's
 *           stepped rows
 * Only the segments of the visible rows are issued, and gl_InstanceID maps to (clone, piece,
 * segment), so rows, gap rule, domains, ranges, width, colours, every cloner setting and the
 * fill are uniform updates.
 *
 * Cloner: clone k of the whole line is offset by k x position, orbits the layer pivot by
 * k x orbit, fades by fade^k and takes its values from row i + k x dataStep (positions and
 * t stay row i's). A clone breaks where its data row is outside the data or has a missing
 * value. Clones are clone-major and far to near, so the original (k = 0) draws last, on top.
 * Instances = visible segments x pieces x clones, capped at MAX_LINE_DRAWN (4M) by dropping
 * far clones (lineCloneCount).
 *
 * Fill ('below'): each segment also draws the area down to the clone's baseline (origin.y +
 * k x position.y). Inside one clone all fill pieces come before all line pieces, and the
 * whole clone before the next nearer one, all in one draw (primitives blend in submission
 * order), so a nearer clone's opaque fill hides the lines behind it: Joy Division style
 * ridgelines, which in 2D (no depth test) rely on exactly this order. In 3D the line is
 * nudged a hair towards the camera so it never z-fights with its own fill.
 *
 * Band ('band', aggregated): the fill pieces span each bucket's lowest to highest y instead,
 * read from a third texture (lo, hi per bucket), drawn under the line in the fill colour.
 */

export interface LineSource {
  table: Table;
  cadences: Record<string, Cadence>;
  /** Calendar fields per time column (for week / month / year aggregation). */
  calendars?: Record<string, CalendarFields>;
  /** The dataset's display timezone (axis dates); UTC without one. */
  timeZone?: string;
}

export interface LineInstance extends LayerInstance {
  apply(layer: LineLayer, cameraMode: '2d' | '3d'): void;
  /** Rows fractions the layer's animation reaches (axes span 'full'). */
  setRowsSpan?(lo: number, hi: number): void;
}

const TEX_WIDTH = 4096;
const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };
const DEG = Math.PI / 180;

const vertexShader = /* glsl */ `
  #define MISSING_TEST -1.0e29
  #define TEX_WIDTH ${TEX_WIDTH}

  uniform highp sampler2D uPoints; // t, source row
  uniform highp sampler2D uValues; // raw y, z, colour per table row
  #ifdef BAND
    uniform highp sampler2D uBand; // lowest, highest raw y per row (bucket)
  #endif
  uniform int uSegFirst;
  uniform int uSegCount;
  uniform int uClones;
  uniform int uFill;        // 1: each clone draws its fill pieces, then its line pieces
  uniform int uDataStep;
  uniform int uRowCount;
  uniform vec3 uClonePosition;
  uniform vec3 uCloneOrbit; // radians per clone
  uniform float uCloneFade;
  uniform float uColourByClone;
  uniform vec3 uPivot;

  uniform vec3 uOrigin;
  uniform vec3 uStep;
  uniform float uTStart;
  uniform float uBreak;
  uniform float uGapFactor;
  uniform float uTimeMode;
  uniform float uWidth;
  uniform float uOpacity;
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
  #endif
  uniform float uReverse;

  // xy: (along, across) px x w, z: w, w: segment length px (perspective-corrected in the fragment).
  varying vec4 vLocal;
  // Colour ramp coordinate at the start and end.
  varying vec2 vRamp;
  // 1 for a fill piece, 0 for a line piece.
  varying float vFill;
  // Layer opacity x clone fade.
  varying float vAlpha;

  vec4 fetchAt(highp sampler2D tex, int i) {
    return texelFetch(tex, ivec2(i % TEX_WIDTH, i / TEX_WIDTH), 0);
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

  // Point before the clone offset: t from the base row, values from the clone's data row.
  vec3 place(float t, vec4 v) {
    vec3 pos = uOrigin + (t - uTStart) * uStep;
    #ifdef CH_Y
      pos.y += mapChannel(v.x, uScaleY, uRangeY);
    #endif
    #ifdef CH_Z
      pos.z += mapChannel(v.y, uScaleZ, uRangeZ);
    #endif
    return pos;
  }

  // Clone offset, then orbit about the layer pivot (as the instancer).
  vec3 cloneOf(vec3 p, float fk, mat3 orbit, bool orbiting) {
    p += fk * uClonePosition;
    if (orbiting) p = uPivot + orbit * (p - uPivot);
    return p;
  }

  // Missing mapped value in a clone's data row; mirrors clonePointDrawable() in line-data.ts.
  bool missingValue(vec4 v) {
    bool m = false;
    #ifdef CH_Y
      m = m || v.x < MISSING_TEST;
    #endif
    #ifdef CH_Z
      m = m || v.y < MISSING_TEST;
    #endif
    #ifdef CH_COLOUR
      m = m || v.z < MISSING_TEST;
    #endif
    return m;
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
    vFill = 0.0;
    vAlpha = 0.0;
  }

  void main() {
    // Clone-major and far to near; inside a clone, fill pieces before line pieces.
    int pieces = uFill + 1;
    int perClone = max(uSegCount * pieces, 1);
    int k = (uClones - 1) - gl_InstanceID / perClone;
    int within = gl_InstanceID % perClone;
    bool isFill = uFill == 1 && within < uSegCount;
    int seg = uSegFirst + (isFill ? within : within - uFill * uSegCount);
    if (k < 0) { hide(); return; }

    vec4 a = fetchAt(uPoints, seg);
    vec4 b = fetchAt(uPoints, seg + 1);
    // Gap rule: mirrors segmentBroken() in line-data.ts.
    if (uBreak > 0.5 && (b.y - a.y > 1.5 || (uTimeMode > 0.5 && b.x - a.x > uGapFactor))) { hide(); return; }

    // The clone's data rows; it breaks where they leave the data or hold a missing value.
    int ra = int(a.y + 0.5) + k * uDataStep;
    int rb = int(b.y + 0.5) + k * uDataStep;
    if (ra < 0 || rb < 0 || ra >= uRowCount || rb >= uRowCount) { hide(); return; }
    vec4 va = fetchAt(uValues, ra);
    vec4 vb = fetchAt(uValues, rb);
    if (missingValue(va) || missingValue(vb)) { hide(); return; }

    float fk = float(k);
    bool orbiting = k > 0 && uCloneOrbit != vec3(0.0);
    mat3 orbit = orbiting ? eulerXYZ(fk * uCloneOrbit) : mat3(1.0);
    vec3 pa = place(a.x, va);
    vec3 pb = place(b.x, vb);
    vAlpha = uOpacity * (k == 0 ? 1.0 : pow(uCloneFade, fk)); // pow(0, 0) is undefined in GLSL

    float cn = uColourByClone > 0.5 ? (uClones > 1 ? fk / float(uClones - 1) : 0.0) : -1.0;
    if (cn >= 0.0 && uReverse > 0.5) cn = 1.0 - cn;

    if (isFill) {
      bool atEnd = position.x > 0.5;
      #ifdef BAND
        // From the bucket's lowest to its highest value.
        vec4 bnd = fetchAt(uBand, atEnd ? rb : ra);
        if (bnd.x < MISSING_TEST || bnd.y < MISSING_TEST) { hide(); return; }
        vec4 vv = atEnd ? vb : va;
        vec3 p = place(atEnd ? b.x : a.x, vec4(position.y > 0.0 ? bnd.y : bnd.x, vv.yzw));
      #else
        // Area from the line down to the baseline (origin.y), then cloned like the line.
        vec3 top = atEnd ? pb : pa;
        vec3 p = position.y > 0.0 ? top : vec3(top.x, uOrigin.y, top.z);
      #endif
      gl_Position = projectionMatrix * modelViewMatrix * vec4(cloneOf(p, fk, orbit, orbiting), 1.0);
      vLocal = vec4(0.0, 0.0, 1.0, 0.0);
      vRamp = vec2(cn);
      vFill = 1.0;
      return;
    }

    vec4 v0 = modelViewMatrix * vec4(cloneOf(pa, fk, orbit, orbiting), 1.0);
    vec4 v1 = modelViewMatrix * vec4(cloneOf(pb, fk, orbit, orbiting), 1.0);
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
    // A hair nearer than its own fill, so the two never z-fight in 3D.
    gl_Position = vec4(s / halfRes * c.w, c.z - 1.0e-5 * c.w, c.w);

    vLocal = vec4(vec2(along, across) * c.w, c.w, len);
    vFill = 0.0;
    if (cn >= 0.0) {
      vRamp = vec2(cn);
    } else {
      vRamp = vec2(rampCoord(va.z), rampCoord(vb.z));
      #ifdef CH_COLOUR
        if (uCategories > 0.0) vRamp.y = vRamp.x; // codes do not interpolate
      #endif
    }
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColour;
  uniform float uWidth;
  uniform float uUseRamp;
  uniform sampler2D uRamp;
  uniform vec3 uFillColour;
  uniform float uFillOpacity;
  varying vec4 vLocal;
  varying vec2 vRamp;
  varying float vFill;
  varying float vAlpha;

  void main() {
    if (vFill > 0.5) {
      float fa = uFillOpacity * vAlpha;
      if (fa <= 0.0) discard;
      gl_FragColor = vec4(uFillColour, fa);
      return;
    }
    vec2 p = vLocal.xy / vLocal.z;
    float len = vLocal.w;
    // Distance from the segment (a capsule: round caps make round joins).
    float d = p.x < 0.0 ? length(p) : (p.x > len ? length(vec2(p.x - len, p.y)) : abs(p.y));
    float a = clamp(0.5 * uWidth - d + 0.5, 0.0, 1.0) * vAlpha;
    if (a <= 0.0) discard;
    vec3 colour = uColour;
    if (uUseRamp > 0.5) {
      float f = len > 0.0 ? clamp(p.x / len, 0.0, 1.0) : 0.0;
      colour = texture2D(uRamp, vec2(mix(vRamp.x, vRamp.y, f), 0.5)).rgb;
    }
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

function dataTexture(n: number, fill: (out: Float32Array) => void): DataTexture {
  const height = Math.max(1, Math.ceil(n / TEX_WIDTH));
  const data = new Float32Array(TEX_WIDTH * height * 4);
  fill(data);
  const tex = new DataTexture(data, TEX_WIDTH, height, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createLine(layer: LineLayer, source: LineSource, cameraMode: '2d' | '3d'): LineInstance {
  const data = buildLineData(layer, source.table, source.cadences, source.calendars);
  return createLineFromData(layer, data, cameraMode, { table: source.table, timeZone: source.timeZone ?? 'UTC' });
}

/**
 * A line from points already built (split lines build every series first to share domains).
 * With `axesFrom` the line draws its own axes; a split line draws one set for all its series.
 */
export function createLineFromData(layer: LineLayer, data: LineData, cameraMode: '2d' | '3d', axesFrom?: { table: Table; timeZone: string }): LineInstance {
  const root = new Group();
  root.name = layer.name;

  if (data.count < 2) {
    // Nothing to draw (not configured yet, or fewer than two points).
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }

  const points = dataTexture(data.count, (out) => {
    for (let p = 0; p < data.count; p++) {
      out[p * 4] = data.points[p * POINT_STRIDE + P_T]!;
      out[p * 4 + 1] = data.points[p * POINT_STRIDE + P_ROW]!;
    }
  });
  const values = dataTexture(data.rowCount, (out) => {
    const channels = [data.y, data.z, data.colour] as const;
    for (let c = 0; c < 3; c++) {
      const v = channels[c]?.values;
      if (!v) continue;
      for (let i = 0; i < data.rowCount; i++) out[i * 4 + c] = v[i]!;
    }
  });
  const bandData = data.band;
  const band = bandData
    ? dataTexture(data.rowCount, (out) => {
        for (let i = 0; i < data.rowCount; i++) {
          out[i * 4] = bandData.lo[i]!;
          out[i * 4 + 1] = bandData.hi[i]!;
        }
      })
    : null;

  // Quad corners: x = 0 at the start, 1 at the end; y = side (-1 / +1). For a fill piece,
  // y -1 is the baseline and +1 the line.
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;

  const defines: Record<string, string> = band ? { BAND: '' } : {};
  const categories = data.colour?.categories ?? 0;
  const uniforms: Record<string, IUniform> = {
    uPoints: { value: points },
    uValues: { value: values },
    uSegFirst: { value: 0 },
    uSegCount: { value: 0 },
    uClones: { value: 1 },
    uFill: { value: 0 },
    uDataStep: { value: 0 },
    uRowCount: { value: data.rowCount },
    uClonePosition: { value: new Vector3() },
    uCloneOrbit: { value: new Vector3() },
    uCloneFade: { value: 1 },
    uColourByClone: { value: 0 },
    uPivot: { value: new Vector3() },
    uOrigin: { value: new Vector3() },
    uStep: { value: new Vector3() },
    uTStart: { value: 0 },
    uBreak: { value: 0 },
    uGapFactor: { value: 1.5 },
    uTimeMode: { value: data.timeMode ? 1 : 0 },
    uWidth: { value: 2 },
    uOpacity: { value: 1 },
    uResolution: { value: new Vector2(OUTPUT_WIDTH, OUTPUT_HEIGHT) },
    uColour: { value: new Color() },
    uReverse: { value: 0 },
    uUseRamp: { value: 0 },
    uRamp: { value: categories > 0 ? paletteTexture() : rampTexture(layer.colourMap.ramp) },
    uFillColour: { value: new Color() },
    uFillOpacity: { value: 1 },
  };
  if (band) uniforms.uBand = { value: band };
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
  if (data.colour) {
    defines.CH_COLOUR = '';
    uniforms.uScaleColour = { value: new Vector4() };
    uniforms.uCategories = { value: categories };
  }

  const material = new ShaderMaterial({ vertexShader, fragmentShader, defines, uniforms, transparent: true, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  root.add(mesh);

  const vec3u = (name: string) => uniforms[name]!.value as Vector3;
  const set = (name: string, value: number) => {
    uniforms[name]!.value = value;
  };

  // Row range results, recomputed only when `rows` or followRange change (apply runs every
  // frame for a modulated layer, and this keeps it allocation-free otherwise).
  let rows0 = NaN;
  let rows1 = NaN;
  let follow = false;
  let segFirst = 0;
  let segCount = 0;

  function apply(next: LineLayer, mode: '2d' | '3d'): void {
    vec3u('uOrigin').fromArray(next.origin);
    vec3u('uStep').fromArray(next.step);
    if (next.rows[0] !== rows0 || next.rows[1] !== rows1 || next.followRange !== follow) {
      rows0 = next.rows[0];
      rows1 = next.rows[1];
      follow = next.followRange;
      const [first, last] = rowRange(next.rows, data.rowCount);
      [segFirst, segCount] = segmentRange(data, first, last);
      set('uTStart', lineTStart(data, next.followRange, first));
    }
    set('uBreak', next.breakOnGaps ? 1 : 0);
    set('uGapFactor', next.gapFactor * data.gapUnit);
    set('uWidth', next.width);
    (uniforms.uColour!.value as Color).set(next.colour);
    set('uOpacity', next.opacity);

    const cl = next.cloner;
    // A band needs its texture (built for 'band'); 'below' draws down to the baseline.
    const fill = band ? next.fill.mode === 'band' : next.fill.mode === 'below';
    const perClone = segCount * (fill ? 2 : 1);
    const clones = lineCloneCount(cl.count, perClone);
    set('uSegFirst', segFirst);
    set('uSegCount', segCount);
    set('uFill', fill ? 1 : 0);
    set('uClones', clones);
    geometry.instanceCount = perClone * clones;
    vec3u('uClonePosition').fromArray(cl.position);
    vec3u('uCloneOrbit').set(cl.orbit[0] * DEG, cl.orbit[1] * DEG, cl.orbit[2] * DEG);
    set('uCloneFade', cl.fade);
    set('uDataStep', cl.dataStep);
    set('uColourByClone', cl.colourByClone ? 1 : 0);
    vec3u('uPivot').fromArray(next.transform.pivot);
    (uniforms.uFillColour!.value as Color).set(next.fill.colour);
    set('uFillOpacity', next.fill.opacity);

    if (yDomain) {
      setScale(uniforms.uScaleY!.value as Vector4, next.y, yDomain(next.y));
      vec3u('uRangeY').set(next.y.range[0], next.y.range[1], next.y.clamp ? 1 : 0);
    }
    if (zDomain) {
      setScale(uniforms.uScaleZ!.value as Vector4, next.z, zDomain(next.z));
      vec3u('uRangeZ').set(next.z.range[0], next.z.range[1], next.z.clamp ? 1 : 0);
    }
    if (colourDomain) setScale(uniforms.uScaleColour!.value as Vector4, next.colourMap, colourDomain(next.colourMap));
    set('uReverse', next.colourMap.reverse ? 1 : 0);
    set('uUseRamp', colourDomain || cl.colourByClone ? 1 : 0);
    if (categories === 0) uniforms.uRamp!.value = rampTexture(next.colourMap.ramp);

    // Same depth rules as the instancer: in 2D draw order decides; in 3D test depth, and
    // write it only when opaque. Lines always blend (anti-aliased edges).
    const additive = next.blend === 'additive';
    const translucent = additive || next.opacity < 1 || (clones > 1 && cl.fade < 1) || (fill && next.fill.opacity < 1);
    material.blending = additive ? AdditiveBlending : NormalBlending;
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
    root.name = next.name;
  }

  const axes = axesFrom ? createLineAxes(root, [{ data, table: axesFrom.table }], axesFrom.timeZone) : null;
  const applyAll = (next: LineLayer, mode: '2d' | '3d'): void => {
    apply(next, mode);
    axes?.apply(next);
  };
  applyAll(layer, cameraMode);

  return {
    object: root,
    apply: applyAll,
    setRowsSpan: (lo, hi) => axes?.setRowsSpan(lo, hi),
    update(_ctx: FrameContext) {},
    dispose() {
      axes?.dispose();
      geometry.dispose();
      material.dispose();
      points.dispose();
      values.dispose();
      band?.dispose();
    },
  };
}
