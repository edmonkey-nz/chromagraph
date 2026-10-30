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
  MeshBasicMaterial,
  NearestFilter,
  NormalBlending,
  RedFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  type IUniform,
} from 'three';
import { Text } from 'troika-three-text';
import type { Table } from '../../../data/columns.ts';
import type { Cadence } from '../../../data/gaps.ts';
import { combineHorizon, horizonExtent, horizonSpan, prepareHorizon, type HorizonFn } from '../../../data/horizon-data.ts';
import { MISSING } from '../../../data/instance-data.ts';
import { rowRange } from '../../../data/line-data.ts';
import { HORIZON_COLUMNS, type HorizonLayer } from '../../../shared/layer-schema.ts';
import { displayText, fontUrl } from '../fonts.ts';
import type { FrameContext, LayerInstance } from './layer.ts';

/**
 * Horizon chart layer: the visible rows are combined into HORIZON_COLUMNS columns per series on
 * the CPU (horizon-data.ts), uploaded as one R32F texture (a row per series, MISSING for gaps),
 * and drawn as one quad covering every strip. The fragment shader finds the strip and column
 * under the pixel and shades it by horizonLevel (its CPU twin): the value's bands stacked in the
 * strip, each a brighter shade of the positive or negative colour. Origin, size, gap, bands,
 * baseline, domain and colours are uniforms; the rows range and `fn` refill the texture in place.
 * Labels are troika Texts, laid out once and moved each apply.
 */

export interface HorizonSourceData {
  table: Table;
  cadences: Record<string, Cadence>;
}

export interface HorizonInstance extends LayerInstance {
  apply(layer: HorizonLayer, cameraMode: '2d' | '3d'): void;
}

const LABEL_BASE_PX = 32;

const vertexShader = /* glsl */ `
  uniform vec3 uOrigin;   // top-left corner
  uniform vec3 uExtent;   // width, total height
  varying vec2 vUv;
  void main() {
    // position.xy runs 0..1 right and 0..1 down from the top-left corner.
    vUv = position.xy;
    vec3 p = uOrigin + vec3(position.x * uExtent.x, -position.y * uExtent.y, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MISSING_TEST -1.0e29
  uniform sampler2D uData;
  uniform vec3 uExtent;     // width, total height, strip count
  uniform vec2 uStrip;      // strip height, gap
  uniform float uColumns;
  uniform float uBands;
  uniform float uBaseline;
  uniform float uDomain;
  uniform vec3 uColour;
  uniform vec3 uNegative;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float py = vUv.y * uExtent.y;
    float pitch = uStrip.x + uStrip.y;
    float s = floor(py / pitch);
    float within = py - s * pitch;
    if (s >= uExtent.z || within > uStrip.x) discard;
    float c = min(floor(vUv.x * uColumns), uColumns - 1.0);
    float v = texelFetch(uData, ivec2(int(c), int(s)), 0).r;
    if (v < MISSING_TEST) discard;
    // Bands of the distance from the baseline, stacked: mirrors horizonLevel() in horizon-data.ts.
    float y = 1.0 - within / uStrip.x;
    float n = min(1.0, abs(v - uBaseline) / uDomain) * uBands;
    float full = floor(n);
    float level = min(uBands, full + (n - full > y ? 1.0 : 0.0));
    if (level < 0.5) discard;
    float shade = uBands > 1.0 ? (level - 1.0) / (uBands - 1.0) : 1.0;
    vec3 colour = (v < uBaseline ? uNegative : uColour) * (0.35 + 0.65 * shade);
    gl_FragColor = vec4(colour, uOpacity);
  }
`;

export function createHorizon(layer: HorizonLayer, source: HorizonSourceData, cameraMode: '2d' | '3d'): HorizonInstance {
  const src = prepareHorizon(layer, source.table, source.cadences);
  const root = new Group();
  root.name = layer.name;
  if (!src) {
    // Not configured yet (no value column, or time mode without a time column): draw nothing.
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }
  const strips = src.names.length;
  const cells = new Float32Array(HORIZON_COLUMNS * strips);
  const count = new Float32Array(HORIZON_COLUMNS * strips);
  const texture = new DataTexture(cells, HORIZON_COLUMNS, strips, RedFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;

  const uniforms: Record<string, IUniform> = {
    uOrigin: { value: new Vector3() },
    uExtent: { value: new Vector3(0, 0, strips) },
    uStrip: { value: new Vector2() },
    uData: { value: texture },
    uColumns: { value: HORIZON_COLUMNS },
    uBands: { value: 4 },
    uBaseline: { value: 0 },
    uDomain: { value: 1 },
    uColour: { value: new Color() },
    uNegative: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  root.add(mesh);

  const labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const labelGroup = new Group();
  labelGroup.renderOrder = 2;
  root.add(labelGroup);
  const labels: Text[] = [];
  const labelStyle = { font: '', uppercase: false };

  let filledFirst = -1;
  let filledLast = -1;
  let filledFn: HorizonFn | null = null;
  const extentFor = { fn: null as HorizonFn | null, baseline: NaN };
  let extent = 1;

  function apply(next: HorizonLayer, mode: '2d' | '3d'): void {
    const [first, last] = rowRange(next.rows, src!.rowCount);
    if (next.fn !== extentFor.fn || next.baseline !== extentFor.baseline) {
      // The auto range comes from every row's columns, so the bands hold while a playhead sweeps.
      const [tLo, tHi] = horizonSpan(src!, 0, src!.rowCount - 1);
      if (Number.isFinite(tLo)) {
        combineHorizon(src!, 0, src!.rowCount - 1, tLo, tHi, HORIZON_COLUMNS, next.fn, cells, count);
        extent = horizonExtent(cells, cells.length, next.baseline);
      }
      extentFor.fn = next.fn;
      extentFor.baseline = next.baseline;
      filledFirst = -1; // the cells were used as scratch
    }
    if (first !== filledFirst || last !== filledLast || next.fn !== filledFn) {
      const [tLo, tHi] = horizonSpan(src!, first, last);
      if (Number.isFinite(tLo)) combineHorizon(src!, first, last, tLo, tHi, HORIZON_COLUMNS, next.fn, cells, count);
      else cells.fill(Number.NaN);
      for (let i = 0; i < cells.length; i++) if (Number.isNaN(cells[i]!)) cells[i] = MISSING;
      filledFirst = first;
      filledLast = last;
      filledFn = next.fn;
      texture.needsUpdate = true;
    }

    const [w, h] = next.size;
    const total = strips * h + (strips - 1) * next.gap;
    (uniforms.uOrigin!.value as Vector3).fromArray(next.origin);
    (uniforms.uExtent!.value as Vector3).set(w, total, strips);
    (uniforms.uStrip!.value as Vector2).set(h, next.gap);
    uniforms.uBands!.value = next.bands;
    uniforms.uBaseline!.value = next.baseline;
    uniforms.uDomain!.value = next.domain ?? extent;
    (uniforms.uColour!.value as Color).set(next.colour);
    (uniforms.uNegative!.value as Color).set(next.negativeColour);
    uniforms.uOpacity!.value = next.opacity;

    const L = next.labels;
    labelGroup.visible = L.enabled && (strips > 1 || src!.names[0] !== '');
    if (labelGroup.visible) {
      const restyle = L.font !== labelStyle.font || L.uppercase !== labelStyle.uppercase;
      labelStyle.font = L.font;
      labelStyle.uppercase = L.uppercase;
      for (let s = 0; s < strips; s++) {
        let t = labels[s];
        if (!t) {
          t = new Text();
          t.material = labelMaterial;
          t.fontSize = LABEL_BASE_PX;
          t.anchorX = 'right';
          t.anchorY = 'middle';
          t.whiteSpace = 'nowrap';
          t.frustumCulled = false;
          t.renderOrder = 2;
          labels[s] = t;
          labelGroup.add(t);
        }
        if (restyle || t.text === '') {
          t.text = displayText(src!.names[s]!, labelStyle.uppercase);
          t.font = fontUrl(labelStyle.font);
          t.sync();
        }
        t.position.set(next.origin[0] - 12, next.origin[1] - s * (h + next.gap) - h / 2, next.origin[2]);
        t.scale.setScalar(L.size / LABEL_BASE_PX);
        t.color = L.colour;
        t.fillOpacity = next.opacity;
      }
    }

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
      for (const t of labels) t.dispose();
      labelMaterial.dispose();
    },
  };
}
