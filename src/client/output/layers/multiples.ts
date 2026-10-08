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
  MeshBasicMaterial,
  NearestFilter,
  NormalBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import { Text } from 'troika-three-text';
import type { CalendarFields } from '../../../data/calendar.ts';
import type { Table } from '../../../data/columns.ts';
import { MISSING } from '../../../data/instance-data.ts';
import { rowRange } from '../../../data/line-data.ts';
import {
  multiplesDomain,
  panelLabel,
  splitRows,
  visibleEntries,
  visiblePanels,
  type MultiplesData,
} from '../../../data/multiples-data.ts';
import type { ScaleType, SmallMultiplesLayer } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { rampTexture } from './ramps.ts';

/**
 * Small multiples layer: every mark of every panel in one instanced draw, plus one instanced
 * draw for the panel frames and a troika Text per panel label.
 *
 * Entries (drawable rows, see multiples-data.ts) live in an RGBA32F data texture
 * (x in panel, panel index, value) read with texelFetch from gl_InstanceID; per-panel
 * min/max/min-positive live in a second small texture for the per-panel domain. Only the
 * entries of the visible `rows` range are issued (a contiguous entry range, entries being in
 * row order), and the first visible panel takes the top-left slot. So columns, origin, panel
 * size, gap, chart, mark size, colours, domain, domain mode, scale, rows and opacity are all
 * uniform updates; only the split, its columns or chunk size rebuild.
 *
 * Labels are laid out once at a base font size and scaled to `labelSize`, so a modulated
 * label size or origin never re-runs troika's layout.
 */

export interface MultiplesSource {
  table: Table;
  calendars: Record<string, CalendarFields>;
}

export interface MultiplesInstance extends LayerInstance {
  apply(layer: SmallMultiplesLayer, cameraMode: '2d' | '3d'): void;
}

const TEX_WIDTH = 4096;
const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };
const CHART_CODE = { bars: 0, dots: 1, cells: 2 } as const;
/**
 * The schema has no quantise step count for small multiples (a contract gap), so quantise
 * uses the same default the other layer types start with.
 */
const QUANTISE_STEPS = 5;
/** Labels beyond this many panels are not drawn (troika meshes are not free). */
const MAX_LABELS = 1500;
/** Labels are laid out at this size and scaled, so label size changes never re-layout. */
const LABEL_BASE_PX = 32;
const FRAME_ALPHA = 0.35;

function packTexture(n: number, components: (ArrayLike<number> | null)[], missing = 0): DataTexture {
  const height = Math.max(1, Math.ceil(n / TEX_WIDTH));
  const data = new Float32Array(TEX_WIDTH * height * 4);
  for (let c = 0; c < 4; c++) {
    const src = components[c];
    if (!src) continue;
    for (let i = 0; i < n; i++) {
      const v = src[i]!;
      data[i * 4 + c] = Number.isNaN(v) ? missing : v;
    }
  }
  const tex = new DataTexture(data, TEX_WIDTH, height, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const SHARED_GLSL = /* glsl */ `
  #define TEX_WIDTH ${TEX_WIDTH}
  uniform int uPanelStart;
  uniform float uColumns;
  uniform vec3 uOrigin;
  uniform vec2 uPanelSize;
  uniform vec2 uGap;

  vec4 fetchAt(highp sampler2D tex, int i) {
    return texelFetch(tex, ivec2(i % TEX_WIDTH, i / TEX_WIDTH), 0);
  }

  // Top-left corner of the panel in layout slot \`slot\`; mirrors panelTopLeft() in multiples-data.ts.
  vec2 panelTopLeft(int slot) {
    float s = float(slot);
    float col = mod(s, uColumns);
    float line = floor(s / uColumns);
    return uOrigin.xy + vec2(col * (uPanelSize.x + uGap.x), -line * (uPanelSize.y + uGap.y));
  }
`;

const markVertex = /* glsl */ `
  #define MISSING_TEST -1.0e29
  ${SHARED_GLSL}
  uniform highp sampler2D uData;
  uniform highp sampler2D uPanels;
  uniform int uFirst;
  uniform float uSlots;
  uniform float uMarkSize;
  uniform int uChart;
  uniform vec4 uScale;
  uniform float uPerPanel;
  uniform float uColourByValue;
  uniform float uReverse;
  uniform sampler2D uRamp;
  uniform vec3 uColour;
  uniform float uOpacity;

  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;

  // Scale maths; mirrors normalise() in src/data/instance-data.ts (always clamped here).
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

  void hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColour = vec3(0.0);
    vAlpha = 0.0;
    vUv = vec2(0.0);
  }

  void main() {
    vec4 d = fetchAt(uData, uFirst + gl_InstanceID); // x in panel, panel, value
    int panel = int(d.y + 0.5);
    int slot = panel - uPanelStart;
    if (slot < 0) { hide(); return; }

    vec4 s = uScale;
    if (uPerPanel > 0.5) {
      // Per-panel auto domain; mirrors panelDomain() in multiples-data.ts.
      vec4 st = fetchAt(uPanels, panel); // min, max, min positive
      s.xy = st.xy;
      if (s.z == 1.0 && !(s.x > 0.0)) {
        s.x = st.z > MISSING_TEST ? st.z : 1.0;
        if (!(s.y > s.x)) s.y = s.x * 10.0;
      }
    }
    float n = norm(d.z, s);

    vec2 topLeft = panelTopLeft(slot);
    float w = uPanelSize.x;
    float h = uPanelSize.y;
    float bottom = topLeft.y - h;
    float step = w / uSlots;
    float xc = topLeft.x + d.x * w + 0.5 * step; // centre of the row's slot
    vec2 corner = position.xy;                   // 0..1
    vec2 p;
    if (uChart == 1) {
      // Dots: round, markSize px, at the value's height.
      p = vec2(xc, bottom + n * h) + (corner - 0.5) * uMarkSize;
    } else {
      // Bars grow from the panel's bottom edge; cells fill the panel height. Width is
      // markSize x the x step, never thinner than 1 px so dense panels stay visible.
      float bw = max(uMarkSize * step, 1.0);
      float bh = uChart == 0 ? n * h : h;
      p = vec2(xc + (corner.x - 0.5) * bw, bottom + corner.y * bh);
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, uOrigin.z, 1.0);

    float alpha = uOpacity;
    vec3 colour = uColour;
    if (uColourByValue > 0.5) {
      colour = texture2D(uRamp, vec2(uReverse > 0.5 ? 1.0 - n : n, 0.5)).rgb;
    } else if (uChart == 2) {
      // A flat-coloured heat strip shows the value as opacity.
      alpha *= uReverse > 0.5 ? 1.0 - n : n;
    }
    vColour = colour;
    vAlpha = alpha;
    vUv = corner;
  }
`;

const markFragment = /* glsl */ `
  uniform int uChart;
  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vUv;
  void main() {
    float a = vAlpha;
    if (uChart == 1) {
      float r = length(vUv - 0.5);
      float aa = fwidth(r);
      a *= 1.0 - smoothstep(0.5 - aa, 0.5, r);
    }
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColour, a);
  }
`;

const frameVertex = /* glsl */ `
  ${SHARED_GLSL}
  varying vec2 vLocal;
  void main() {
    vec2 topLeft = panelTopLeft(gl_InstanceID);
    vLocal = position.xy * uPanelSize;
    vec2 p = vec2(topLeft.x, topLeft.y - uPanelSize.y) + vLocal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, uOrigin.z, 1.0);
  }
`;

const frameFragment = /* glsl */ `
  uniform vec2 uPanelSize;
  uniform vec3 uColour;
  uniform float uOpacity;
  varying vec2 vLocal;
  void main() {
    // About one screen pixel wide whatever the transform or camera.
    vec2 px = max(fwidth(vLocal), vec2(1.0e-4));
    vec2 edge = min(vLocal, uPanelSize - vLocal) / px;
    float d = min(edge.x, edge.y);
    float a = (1.0 - smoothstep(0.5, 1.5, d)) * uOpacity;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(uColour, a);
  }
`;

/** A unit quad, (0,0) to (1,1), shared by marks and frames. */
function unitQuad(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}

export function createMultiples(layer: SmallMultiplesLayer, source: MultiplesSource, cameraMode: '2d' | '3d'): MultiplesInstance {
  const data = splitRows(layer, source.table, source.calendars);
  const root = new Group();
  root.name = layer.name;
  if (!data || data.panelCount === 0) {
    // Not configured yet (no value or split column), or nothing to split.
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }
  const d: MultiplesData = data;

  const entries = packTexture(d.count, [d.x, d.panel, d.value, null]);
  const panels = packTexture(d.panelCount, [d.panelMin, d.panelMax, d.panelMinPositive, null], MISSING);

  // Uniforms shared by marks and frames (same objects, so one write moves both).
  const layout = {
    uPanelStart: { value: 0 },
    uColumns: { value: 1 },
    uOrigin: { value: new Vector3() },
    uPanelSize: { value: new Vector2() },
    uGap: { value: new Vector2() },
  } satisfies Record<string, IUniform>;

  const markGeometry = unitQuad();
  const markUniforms: Record<string, IUniform> = {
    ...layout,
    uData: { value: entries },
    uPanels: { value: panels },
    uFirst: { value: 0 },
    uSlots: { value: d.slots },
    uMarkSize: { value: 1 },
    uChart: { value: 0 },
    uScale: { value: new Vector4() },
    uPerPanel: { value: 0 },
    uColourByValue: { value: 0 },
    uReverse: { value: 0 },
    uRamp: { value: rampTexture(layer.ramp) },
    uColour: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const markMaterial = new ShaderMaterial({
    vertexShader: markVertex,
    fragmentShader: markFragment,
    uniforms: markUniforms,
    side: DoubleSide,
    transparent: true,
  });
  const marks = new Mesh(markGeometry, markMaterial);
  marks.frustumCulled = false;
  marks.renderOrder = 1;

  const frameGeometry = unitQuad();
  const frameUniforms: Record<string, IUniform> = { ...layout, uColour: { value: new Color() }, uOpacity: { value: 1 } };
  const frameMaterial = new ShaderMaterial({
    vertexShader: frameVertex,
    fragmentShader: frameFragment,
    uniforms: frameUniforms,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  const frames = new Mesh(frameGeometry, frameMaterial);
  frames.frustumCulled = false;
  frames.renderOrder = 0;
  root.add(frames, marks);

  // Labels: created on first need (labelSize > 0), one per panel up to MAX_LABELS.
  const labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const labelGroup = new Group();
  labelGroup.renderOrder = 2;
  root.add(labelGroup);
  let labels: Text[] | null = null;

  function ensureLabels(): Text[] {
    if (labels) return labels;
    labels = [];
    const n = Math.min(d.panelCount, MAX_LABELS);
    for (let p = 0; p < n; p++) {
      const t = new Text();
      t.material = labelMaterial;
      t.text = panelLabel(d, p);
      t.fontSize = LABEL_BASE_PX;
      t.anchorX = 'left';
      t.anchorY = 'bottom';
      t.whiteSpace = 'nowrap';
      t.frustumCulled = false;
      t.renderOrder = 2;
      t.sync();
      labels.push(t);
      labelGroup.add(t);
    }
    return labels;
  }

  const materials = [markMaterial, frameMaterial, labelMaterial] as const;
  const v3 = (u: IUniform) => u.value as Vector3;
  const v2 = (u: IUniform) => u.value as Vector2;

  function apply(next: SmallMultiplesLayer, mode: '2d' | '3d'): void {
    const [first, last] = rowRange(next.rows, d.rowCount);
    const [start, count] = visibleEntries(d, first, last);
    const [panelStart, panelCount] = visiblePanels(d, start, count);
    const columns = Math.max(1, Math.floor(next.columns));

    layout.uPanelStart.value = panelStart;
    layout.uColumns.value = columns;
    v3(layout.uOrigin).fromArray(next.origin);
    v2(layout.uPanelSize).fromArray(next.panelSize);
    v2(layout.uGap).fromArray(next.gap);

    markUniforms.uFirst!.value = start;
    markGeometry.instanceCount = count;
    markUniforms.uMarkSize!.value = next.markSize;
    markUniforms.uChart!.value = CHART_CODE[next.chart];
    const domain = multiplesDomain(next.scale, next.domain, d);
    (markUniforms.uScale!.value as Vector4).set(domain[0], domain[1], SCALE_CODE[next.scale], QUANTISE_STEPS);
    markUniforms.uPerPanel!.value = next.domainMode === 'per-panel' ? 1 : 0;
    markUniforms.uColourByValue!.value = next.colourByValue ? 1 : 0;
    markUniforms.uReverse!.value = next.reverse ? 1 : 0;
    markUniforms.uRamp!.value = rampTexture(next.ramp);
    (markUniforms.uColour!.value as Color).set(next.colour);
    markUniforms.uOpacity!.value = next.opacity;

    frameGeometry.instanceCount = next.frame ? panelCount : 0;
    frames.visible = next.frame && panelCount > 0;
    (frameUniforms.uColour!.value as Color).set(next.labelColour);
    frameUniforms.uOpacity!.value = FRAME_ALPHA * next.opacity;

    const showLabels = next.labelSize > 0 && panelCount > 0;
    labelGroup.visible = showLabels;
    if (showLabels) {
      const list = ensureLabels();
      const scale = next.labelSize / LABEL_BASE_PX;
      const lift = next.labelSize * 0.2;
      for (let p = 0; p < list.length; p++) {
        const t = list[p]!;
        const slot = p - panelStart;
        t.visible = slot >= 0 && slot < panelCount;
        if (!t.visible) continue;
        // panelTopLeft() inlined (no tuple allocation per label per frame).
        const col = slot % columns;
        const line = Math.floor(slot / columns);
        t.position.set(
          next.origin[0] + col * (next.panelSize[0] + next.gap[0]),
          next.origin[1] - line * (next.panelSize[1] + next.gap[1]) + lift,
          next.origin[2],
        );
        t.scale.setScalar(scale);
        t.color = next.labelColour;
        t.fillOpacity = next.opacity;
      }
    }

    // Same depth rules as the instancer: in 2D draw order decides; in 3D test depth, and
    // write it only when opaque. Marks always blend (round dots, anti-aliased edges).
    const additive = next.blend === 'additive';
    const translucent = additive || next.opacity < 1 || next.chart === 'dots' || (next.chart === 'cells' && !next.colourByValue);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i]!;
      m.blending = additive ? AdditiveBlending : NormalBlending;
      m.depthTest = mode === '3d' && !additive;
    }
    markMaterial.depthWrite = mode === '3d' && !translucent;
    root.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {},
    dispose() {
      markGeometry.dispose();
      frameGeometry.dispose();
      markMaterial.dispose();
      frameMaterial.dispose();
      entries.dispose();
      panels.dispose();
      for (const t of labels ?? []) t.dispose();
      labelMaterial.dispose(); // also disposes troika's derived materials
    },
  };
}
