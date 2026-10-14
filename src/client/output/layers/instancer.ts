import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
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
import { BatchedText, Text } from 'troika-three-text';
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
import { layoutAxes, type AxisSegment } from '../../../data/instance-axes.ts';
import { DateLabels, emptyPlacement, labelRows, labelText, placeLabel, visibleLabels } from '../../../data/instance-labels.ts';
import type { ColourMapping, InstancerAxes, InstancerLayer, Mapping, Primitive, ScaleType } from '../../../shared/layer-schema.ts';
import { displayText, fontUrl } from '../fonts.ts';
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
 *
 * Calendar fields (year index, day of year) are uploaded whenever the layer's time column
 * has them, whatever the arrangement, so switching arrangement never rebuilds and a scene
 * morph can move the marks between any two layouts: the layout uniforms are packed into
 * uLayout, and up to two frozen "from" layouts (uFrom) are mixed in while a morph runs
 * (beginLayoutMorph / setLayoutMix / endLayoutMorph). Two levels make an interrupted morph
 * seamless: what was on screen (a blend of two layouts) morphs on to the new one.
 */

export interface InstancerData {
  table: Table;
  cadences: Record<string, Cadence>;
  calendars: Record<string, CalendarFields>;
  /** For date labels (the dataset's display timezone). */
  timeZone?: string;
}

export interface InstancerInstance extends LayerInstance {
  apply(layer: InstancerLayer, cameraMode: '2d' | '3d'): void;
  /**
   * Freeze the layout now on screen as the "from" layout of a morph (stacking on an
   * unfinished one). Until endLayoutMorph, positions are mix(from, current layout, mix).
   */
  beginLayoutMorph(): void;
  /** Progress of the newest layout morph, 0..1 (eased). Uniform update only. */
  setLayoutMix(mix: number): void;
  /** Drop the from layouts: positions are exactly the current layout again. */
  endLayoutMorph(): void;
  /** Rows (fractions) of the layer's whole animation: what axes with span 'full' are laid out over. */
  setRowsSpan(lo: number, hi: number): void;
}

/** Instancer fields that only move the marks (blended by position during a morph). */
export const INSTANCER_LAYOUT_KEYS: ReadonlySet<string> = new Set([
  'arrangement',
  'origin',
  'step',
  'gridColumns',
  'cell',
  'radius',
  'angleStep',
  'radiusStep',
  'followRange',
]);

/** True when the layer's time column has calendar fields, so they are always uploaded. */
export function instancerCalendarReady(layer: InstancerLayer, source: Pick<InstancerData, 'table' | 'calendars'>): boolean {
  const name = layer.timeColumn;
  if (!name || !source.calendars[name]) return false;
  return source.table.columns.some((c) => c.name === name && c.type === 'time');
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

  // Layout, packed (see packLayout): [code, gridColumns, radius, angleStep],
  // [origin.xyz, radiusStep], [step.xyz, tStart], [cell.xy, -, -].
  uniform vec4 uLayout[4];
  // Frozen layouts of a morph in progress: [0..3] older, [4..7] newer.
  uniform vec4 uFrom[8];
  uniform int uFromLevels;
  uniform vec2 uLayoutMix;   // older -> newer (frozen), from -> current
  uniform float uNeedCalendar;
  uniform int uFirstRow;
  uniform int uVisibleRows;
  uniform int uRowCount;
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

  // Arranged position of a row from a packed layout (see layer-schema.ts for the maths).
  vec3 arrange(vec4 a, vec4 b, vec4 c, vec4 d, vec4 d0) {
    float t = d0.x - c.w;
    int code = int(a.x + 0.5);
    if (code == 0) return b.xyz + t * c.xyz;
    if (code == 1) {
      float col = mod(t, a.y);
      float line = floor(t / a.y);
      return b.xyz + vec3(col * d.x, -line * d.y, 0.0);
    }
    if (code == 2) return b.xyz + vec3(d0.z * d.x, -d0.y * d.y, 0.0);
    float ang = radians(t * a.w);
    float r = a.z + (code == 4 ? t * b.w : 0.0);
    return b.xyz + vec3(sin(ang) * r, cos(ang) * r, 0.0);
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
      hidden = hidden || (uNeedCalendar > 0.5 && d0.y < MISSING_TEST);
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

    vec3 p = arrange(uLayout[0], uLayout[1], uLayout[2], uLayout[3], d0);
    if (uFromLevels > 0) {
      vec3 from = arrange(uFrom[4], uFrom[5], uFrom[6], uFrom[7], d0);
      if (uFromLevels > 1) from = mix(arrange(uFrom[0], uFrom[1], uFrom[2], uFrom[3], d0), from, uLayoutMix.x);
      p = mix(from, p, uLayoutMix.y);
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

/**
 * Box edges (EDGES, box primitive only): each face's border is found from its own 0..1 UVs,
 * and the UV gradient turns the distance to the border into screen px, so edges are `width` px
 * wide at any distance or angle (thinner on faces under 4 × width across). Faces show at
 * uFaceOpacity under the edges (0: outlines only), and glow brightens the edge towards white
 * and adds a soft halo inwards over the face, which the layer's glow (bloom) then spreads for a
 * neon look.
 */
const fragmentShader = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;
  varying vec3 vNormal;
  #ifdef EDGES
    uniform float uEdges;
    uniform vec3 uEdgeColour;
    uniform float uEdgeWidth;
    uniform float uFaceOpacity;
    uniform float uEdgeGlow;
  #endif

  void main() {
    float a = vAlpha;
    vec3 col = vColour;
    #ifdef ROUND
      float r = length(vUv - 0.5);
      float aa = length(vec2(dFdx(r), dFdy(r)));
      a *= 1.0 - smoothstep(0.5 - aa, 0.5, r);
    #endif
    #ifdef LIT
      float diffuse = max(dot(normalize(vNormal), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
      col *= 0.35 + 0.65 * diffuse;
    #endif
    #ifdef EDGES
      if (uEdges > 0.5) {
        // Gradient length, not fwidth (|dx| + |dy|), which is up to 41% too big on diagonal
        // edges, so the width would change with the edge's angle as the camera turns.
        vec2 g = max(vec2(length(vec2(dFdx(vUv.x), dFdy(vUv.x))), length(vec2(dFdx(vUv.y), dFdy(vUv.y)))), vec2(1.0e-6));
        vec2 px = min(vUv, 1.0 - vUv) / g;              // screen px to the face's border, per axis
        float d = min(px.x, px.y);
        // A face narrower than four edge widths (edge-on, or tiny) gets thinner edges, so a
        // sliver of side face doesn't fill with edge colour.
        vec2 w = min(vec2(uEdgeWidth), 0.25 / g);
        vec2 band = 1.0 - smoothstep(w - 0.5, w + 0.5, px);
        float edge = max(band.x, band.y);
        float halo = uEdgeGlow * uEdgeGlow * 0.6 * exp(-max(d - uEdgeWidth, 0.0) / (3.0 + 2.0 * uEdgeWidth));
        vec3 lit = mix(uEdgeColour * (1.0 + 2.0 * uEdgeGlow), vec3(1.0), 0.35 * uEdgeGlow);
        // Edge over halo over face, composited premultiplied.
        float under = halo + (1.0 - halo) * uFaceOpacity;
        float coverage = edge + (1.0 - edge) * under;
        vec3 rgb = edge * lit + (1.0 - edge) * (halo * uEdgeColour + (1.0 - halo) * uFaceOpacity * col);
        col = rgb / max(coverage, 1.0e-4);
        a *= coverage;
      }
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

/** Pack the layout fields into 16 floats (the shader's uLayout). */
function packLayout(l: InstancerLayer, tStart: number, out: Float32Array): void {
  out[0] = ARRANGEMENT_CODE[l.arrangement];
  out[1] = Math.max(1, l.gridColumns);
  out[2] = l.radius;
  out[3] = l.angleStep;
  out[4] = l.origin[0];
  out[5] = l.origin[1];
  out[6] = l.origin[2];
  out[7] = l.radiusStep;
  out[8] = l.step[0];
  out[9] = l.step[1];
  out[10] = l.step[2];
  out[11] = tStart;
  out[12] = l.cell[0];
  out[13] = l.cell[1];
  out[14] = 0;
  out[15] = 0;
}

export function createInstancer(layer: InstancerLayer, source: InstancerData, cameraMode: '2d' | '3d'): InstancerInstance {
  // Calendar fields whenever available (see the header), so the arrangement is never structural.
  const data: InstanceData = instancerCalendarReady(layer, source)
    ? buildInstanceData({ ...layer, arrangement: 'calendar' }, source.table, source.cadences, source.calendars)
    : buildInstanceData(layer, source.table, source.cadences, source.calendars);
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
  // The edge style is compiled into every box layer and switched by a uniform, so turning it
  // on or off (or modulating it) never recompiles.
  if (layer.primitive === 'box') defines.EDGES = '';

  const colourData = data.channels.colour;
  /** Current layout and the morph's frozen ones, packed as in the shader. */
  const layout = new Float32Array(16);
  const from = new Float32Array(32);
  let fromLevels = 0;
  /** Arrangement codes of the frozen layouts (calendar rows with no date hide while any is a calendar). */
  let fromCalendar = false;
  const uniforms: Record<string, IUniform> = {
    uData0: { value: textures[0] },
    uData1: { value: textures[1] },
    uData2: { value: textures[2] },
    uLayout: { value: layout },
    uFrom: { value: from },
    uFromLevels: { value: 0 },
    uLayoutMix: { value: new Vector2(1, 1) },
    uNeedCalendar: { value: 0 },
    uFirstRow: { value: 0 },
    uVisibleRows: { value: 0 },
    uRowCount: { value: n },
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
    uEdges: { value: 0 },
    uEdgeColour: { value: new Color() },
    uEdgeWidth: { value: 2 },
    uFaceOpacity: { value: 1 },
    uEdgeGlow: { value: 0 },
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
  const set = (name: string, value: number) => {
    uniforms[name]!.value = value;
  };

  function apply(next: InstancerLayer, mode: '2d' | '3d'): void {
    if (next.arrangement === 'calendar' && !data.yearIndex) throw new Error('the calendar arrangement needs a time column');
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
    geometry.instanceCount = next.labels.enabled && next.labels.hidePoints ? 0 : visible * clones;
    const tStart = next.followRange && next.arrangement !== 'calendar' ? firstDefinedT(data.t, first) : 0;
    packLayout(next, tStart, layout);
    set('uNeedCalendar', next.arrangement === 'calendar' || fromCalendar ? 1 : 0);

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

    const edges = next.primitive === 'box' && next.edges.enabled;
    set('uEdges', edges ? 1 : 0);
    (uniforms.uEdgeColour!.value as Color).set(next.edges.colour);
    set('uEdgeWidth', next.edges.width);
    set('uFaceOpacity', next.edges.faceOpacity);
    set('uEdgeGlow', next.edges.glow);

    const additive = next.blend === 'additive';
    const translucent =
      additive ||
      next.opacity < 1 ||
      next.primitive === 'point' ||
      hasOpacityChannel ||
      (clones > 1 && cl.fade < 1) ||
      (edges && next.edges.faceOpacity < 1);
    material.transparent = translucent;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    // 2D layers sit on one plane, so depth testing would only cause z-fighting; draw order
    // (layer order, then clone and row order) decides what is on top.
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
    mesh.name = next.name;
    applyLabels(next, first, last, visible, tStart);
    applyAxes(next, first, last, tStart);
  }

  // ---- labels at points of the arrangement (data/instance-labels.ts) ----
  // A BatchedText child of the mesh, so the layer transform, visibility and effects apply.
  // Slot k shows candidate k * stride: a label keeps its slot (and its laid-out text) as the
  // visible row range moves, so a data playhead only lays out labels entering the range.
  const labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const labelBatch = new BatchedText();
  labelBatch.material = labelMaterial;
  labelBatch.frustumCulled = false;
  labelBatch.renderOrder = 2;
  labelBatch.visible = false;
  mesh.add(labelBatch);
  const labelPool: Text[] = [];
  const dates = new DateLabels(source.timeZone ?? 'UTC');
  const placement = emptyPlacement();
  let candidates: Int32Array = new Int32Array(0);
  let candidateTexts: (string | undefined)[] = [];
  let candidatesFor: InstancerLayer['labels'] | null = null;
  let candidatesTimeColumn: string | null = null;
  /** What the slots were last placed for (compared field by field: apply() runs per frame when modulated). */
  const placed = { from: -1, to: -1, stride: 0, layout: new Float32Array(16), labels: null as InstancerLayer['labels'] | null, opacity: -1 };

  function labelSlot(i: number): Text {
    let text = labelPool[i];
    if (!text) {
      text = new Text();
      text.text = '';
      text.whiteSpace = 'nowrap';
      labelPool.push(text);
      labelBatch.addText(text);
    }
    return text;
  }

  function sameLayout(a: Float32Array, b: Float32Array): boolean {
    for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function applyLabels(next: InstancerLayer, first: number, last: number, visible: number, tStart: number): void {
    const L = next.labels;
    if (!L.enabled || visible === 0) {
      labelBatch.visible = false;
      return;
    }
    const prev = candidatesFor;
    if (!prev || prev.every !== L.every || prev.rows !== L.rows || prev.text !== L.text || prev.column !== L.column || candidatesTimeColumn !== next.timeColumn) {
      const calendar = next.timeColumn ? (source.calendars[next.timeColumn] ?? null) : null;
      candidates = labelRows(L, data.t, calendar);
      candidateTexts = new Array<string | undefined>(candidates.length);
      candidatesFor = L;
      candidatesTimeColumn = next.timeColumn;
      placed.from = -1; // force a full re-place
      for (const t of labelPool) if (t.text !== '') t.text = '';
    }
    const { from, to, stride } = visibleLabels(candidates, first, last);
    const style = placed.labels;
    if (
      from === placed.from &&
      to === placed.to &&
      stride === placed.stride &&
      next.opacity === placed.opacity &&
      sameLayout(layout, placed.layout) &&
      style !== null &&
      style.size === L.size &&
      style.offset === L.offset &&
      style.orientation === L.orientation &&
      style.colour === L.colour &&
      style.font === L.font &&
      style.uppercase === L.uppercase
    ) {
      labelBatch.visible = true;
      return;
    }
    placed.from = from;
    placed.to = to;
    placed.stride = stride;
    placed.opacity = next.opacity;
    placed.layout.set(layout);
    placed.labels = L;

    const calendar = next.timeColumn ? (source.calendars[next.timeColumn] ?? null) : null;
    const slots = Math.ceil(candidates.length / stride);
    let shown = 0;
    for (let slot = 0; slot < slots; slot++) {
      const k = slot * stride;
      const inRange = k >= from && k < to;
      if (!inRange) {
        const t = labelPool[slot];
        if (t && t.text !== '') t.text = '';
        continue;
      }
      const row = candidates[k]!;
      let s = candidateTexts[k];
      if (s === undefined) {
        s = labelText(L, row, source.table, next.timeColumn, calendar, dates);
        candidateTexts[k] = s;
      }
      const text = labelSlot(slot);
      const shownText = displayText(s, L.uppercase);
      if (text.text !== shownText) text.text = shownText;
      if (s === '') continue;
      text.font = fontUrl(L.font);
      shown++;
      placeLabel(next, data.t[row]! - tStart, data.yearIndex?.[row] ?? 0, data.dayOfYear?.[row] ?? 0, placement);
      text.fontSize = L.size;
      text.color = L.colour;
      text.fillOpacity = next.opacity;
      text.anchorX = placement.anchorX;
      text.anchorY = placement.anchorY;
      text.position.set(placement.x, placement.y, placement.z);
      text.rotation.z = placement.rotation;
    }
    labelBatch.visible = shown > 0;
  }

  // ---- axes and value labels (data/instance-axes.ts) ----
  // Lines are one non-indexed mesh of quads with RGBA vertex colours; texts a second
  // BatchedText. Both are children of the mesh (so the transform applies) and are rebuilt
  // only when something they depend on changes: the axes settings, or the numbers in
  // `axisKey`, which apply() refills each call without allocating (it runs per frame when a
  // layer is modulated).
  const axisMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const axisGeometry = new BufferGeometry();
  const axisLines = new Mesh(axisGeometry, axisMaterial);
  axisLines.frustumCulled = false;
  axisLines.renderOrder = 2;
  axisLines.visible = false;
  mesh.add(axisLines);
  const axisTextMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const axisBatch = new BatchedText();
  axisBatch.material = axisTextMaterial;
  axisBatch.frustumCulled = false;
  axisBatch.renderOrder = 2;
  axisBatch.visible = false;
  mesh.add(axisBatch);
  /** One text object per AxisText key, so a label is only laid out again when its text changes. */
  const axisTexts = new Map<string, Text>();
  /** Texts whose key went away, cleared, for the next new key. */
  const axisSpare: Text[] = [];
  /** Rows [first, last] of the layer's whole animation (setRowsSpan), or -1 before one arrives. */
  const span = { first: -1, last: -1 };
  /** applyAxes' last arguments, so a new span can lay the axes out again (reused: apply runs per frame). */
  const lastAxes = { next: null as InstancerLayer | null, first: 0, last: 0, tStart: 0 };
  const axisKey = new Float64Array(48);
  const axisSeen = new Float64Array(48).fill(Number.NaN);
  let axisFor: InstancerAxes | null = null;
  const axisColour = new Color();

  /** The numbers the axes layout depends on (besides the axes settings), into `axisKey`. */
  function fillAxisKey(next: InstancerLayer, first: number, last: number, tStart: number): void {
    let i = 0;
    const k = axisKey;
    k[i++] = first;
    k[i++] = last;
    k[i++] = tStart;
    k[i++] = span.first;
    k[i++] = span.last;
    k[i++] = next.opacity;
    for (let j = 0; j < 16; j++) k[i++] = layout[j]!;
    for (let j = 0; j < 3; j++) k[i++] = next.size[j]!;
    k[i++] = next.heightAxis === 'z' ? 1 : 0;
    for (const name of ['y', 'z', 'height', 'size'] as const) {
      const m = next.channels[name];
      const memo = domains.get(name);
      const d = memo ? memo(m) : null;
      k[i++] = m.range[0];
      k[i++] = m.range[1];
      k[i++] = d ? d[0] : Number.NaN;
      k[i++] = d ? d[1] : Number.NaN;
      k[i++] = m.clamp ? 1 : 0;
    }
  }

  function sameAxisKey(): boolean {
    for (let i = 0; i < axisKey.length; i++) {
      const a = axisKey[i]!;
      const b = axisSeen[i]!;
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
    }
    return true;
  }

  /** Quads for the segments, `width` px across, coloured with the layer opacity applied. */
  function buildAxisLines(segments: readonly AxisSegment[], opacity: number): void {
    const pos = new Float32Array(segments.length * 18);
    const col = new Float32Array(segments.length * 24);
    let p = 0;
    let c = 0;
    for (const sg of segments) {
      const [ax, ay, az] = sg.a;
      const [bx, by, bz] = sg.b;
      // Across the line in the x/y plane; a line straight along z widens along x.
      let px = by - ay;
      let py = -(bx - ax);
      const len = Math.hypot(px, py);
      if (len > 1e-9) {
        px /= len;
        py /= len;
      } else {
        px = 1;
        py = 0;
      }
      const hw = sg.width / 2;
      const corners = [
        [ax - px * hw, ay - py * hw, az],
        [bx - px * hw, by - py * hw, bz],
        [bx + px * hw, by + py * hw, bz],
        [ax - px * hw, ay - py * hw, az],
        [bx + px * hw, by + py * hw, bz],
        [ax + px * hw, ay + py * hw, az],
      ];
      axisColour.set(sg.colour);
      for (const v of corners) {
        pos[p++] = v[0]!;
        pos[p++] = v[1]!;
        pos[p++] = v[2]!;
        col[c++] = axisColour.r;
        col[c++] = axisColour.g;
        col[c++] = axisColour.b;
        col[c++] = sg.opacity * opacity;
      }
    }
    axisGeometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    axisGeometry.setAttribute('color', new Float32BufferAttribute(col, 4));
    axisGeometry.computeBoundingSphere();
    axisLines.visible = segments.length > 0;
  }

  function applyAxes(next: InstancerLayer, first: number, last: number, tStart: number): void {
    lastAxes.next = next;
    lastAxes.first = first;
    lastAxes.last = last;
    lastAxes.tStart = tStart;
    const A = next.axes;
    if (!A.values.enabled && !A.x.enabled && !A.y.enabled) {
      axisLines.visible = false;
      axisBatch.visible = false;
      axisFor = A;
      return;
    }
    fillAxisKey(next, first, last, tStart);
    if (A === axisFor && sameAxisKey()) return;
    axisFor = A;
    axisSeen.set(axisKey);

    const resolved: Partial<Record<'y' | 'z' | 'height' | 'size', readonly [number, number]>> = {};
    for (const name of ['y', 'z', 'height', 'size'] as const) {
      const memo = domains.get(name);
      if (memo) resolved[name] = memo(next.channels[name]);
    }
    const spanRows = span.first >= 0 ? { first: span.first, last: span.last } : undefined;
    const { segments, texts } = layoutAxes({ layer: next, data, table: source.table, domains: resolved, first, last, tStart, dates, span: spanRows });
    buildAxisLines(segments, next.opacity);

    // Keys that went away free their text (cleared, so nothing stale shows when it is reused).
    const keep = new Set<string>();
    for (const t of texts) keep.add(t.key);
    for (const [key, text] of axisTexts) {
      if (keep.has(key)) continue;
      axisTexts.delete(key);
      if (text.text !== '') text.text = '';
      axisSpare.push(text);
    }
    const font = fontUrl(A.font);
    for (const t of texts) {
      let text = axisTexts.get(t.key);
      if (!text) {
        text = axisSpare.pop();
        if (!text) {
          text = new Text();
          text.whiteSpace = 'nowrap';
          axisBatch.addText(text);
        }
        axisTexts.set(t.key, text);
      }
      const shown = displayText(t.text, A.uppercase);
      if (text.text !== shown) text.text = shown;
      text.font = font;
      text.fontSize = t.size;
      text.color = t.colour;
      text.fillOpacity = next.opacity;
      text.anchorX = t.anchorX;
      text.anchorY = t.anchorY;
      text.position.set(t.x, t.y, t.z);
      text.rotation.z = t.rotation;
    }
    axisBatch.visible = texts.length > 0;
  }

  apply(layer, cameraMode);

  const layoutMix = uniforms.uLayoutMix!.value as Vector2;

  return {
    object: mesh,
    apply,
    beginLayoutMorph() {
      if (fromLevels === 2) {
        // A third level cannot be drawn: keep whichever older layout dominates the blend.
        if (layoutMix.x >= 0.5) from.copyWithin(0, 16, 32);
        fromLevels = 1;
      } else if (fromLevels === 1) {
        from.copyWithin(0, 16, 32);
      }
      // The newest frozen layout is the one drawn until now; the previous mix is frozen.
      from.set(layout, 16);
      layoutMix.x = fromLevels === 1 ? layoutMix.y : 1;
      layoutMix.y = 0;
      fromLevels += 1;
      fromCalendar = from[16] === ARRANGEMENT_CODE.calendar || (fromLevels > 1 && from[0] === ARRANGEMENT_CODE.calendar);
      set('uFromLevels', fromLevels);
      set('uNeedCalendar', layout[0] === ARRANGEMENT_CODE.calendar || fromCalendar ? 1 : 0);
    },
    setLayoutMix(mix: number) {
      layoutMix.y = mix;
    },
    endLayoutMorph() {
      fromLevels = 0;
      fromCalendar = false;
      layoutMix.set(1, 1);
      set('uFromLevels', 0);
      set('uNeedCalendar', layout[0] === ARRANGEMENT_CODE.calendar ? 1 : 0);
    },
    setRowsSpan(lo: number, hi: number) {
      span.first = Math.max(0, Math.floor(lo * n));
      span.last = Math.min(n - 1, Math.ceil(hi * n) - 1);
      if (lastAxes.next) applyAxes(lastAxes.next, lastAxes.first, lastAxes.last, lastAxes.tStart);
    },
    update(_ctx: FrameContext) {
      // Static between applies; modulators drive it through apply().
    },
    dispose() {
      // The base geometry's buffers belong to `geometry` now; disposing it frees them.
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
      for (const text of labelPool) {
        labelBatch.removeText(text);
        text.dispose();
      }
      labelBatch.dispose();
      labelMaterial.dispose();
      for (const text of [...axisTexts.values(), ...axisSpare]) {
        axisBatch.removeText(text);
        text.dispose();
      }
      axisBatch.dispose();
      axisTextMaterial.dispose();
      axisGeometry.dispose();
      axisMaterial.dispose();
    },
  };
}

