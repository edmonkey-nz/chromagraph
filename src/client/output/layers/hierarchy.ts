import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import { BatchedText, Text } from 'troika-three-text';
import type { CalendarFields } from '../../../data/calendar.ts';
import type { Table } from '../../../data/columns.ts';
import { hierarchyClient, type HierarchyClient } from '../../../data/hierarchy-client.ts';
import {
  depthStats,
  hierarchyDomainInto,
  MAX_DEPTH,
  prepareHierarchyInputs,
  type DepthStats,
  type GroupInputs,
  type HierarchyTree,
} from '../../../data/hierarchy-data.ts';
import {
  ARC_VERTEX_STRIDE,
  CELL_STRIDE,
  NODE_STRIDE,
  usesInnerRadius,
  usesPadding,
  type HierarchyLayoutName,
  type HierarchyLayoutResult,
} from '../../../data/hierarchy-layout.ts';
import type { HierarchyLayer, ScaleType } from '../../../shared/layer-schema.ts';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../stage.ts';
import { displayText, fontUrl } from '../fonts.ts';
import type { FrameContext, LayerInstance } from './layer.ts';
import { rampTexture } from './ramps.ts';

declare module 'troika-three-text' {
  /** Batches member Text objects into one draw call (troika 0.52, WebGL2). */
  export class BatchedText extends Text {
    addText(text: Text): void;
    removeText(text: Text): void;
  }
  interface Text {
    /** [minX, minY, maxX, maxY] in the text's local space (after anchoring), or null. */
    clipRect: [number, number, number, number] | null;
  }
}

/**
 * Hierarchy layer (dendrogram, tree, radial dendrogram, sunburst, icicle, pack, treemap).
 *
 * Grouping and layout run in the hierarchy worker (hierarchy-client.ts), never on this
 * thread. The layer keeps drawing its current layout until a new one arrives, then swaps
 * it in from update() (inside the LayerHost fence). At most one job per layer is in
 * flight; when it finishes, the latest wanted parameters are sent if they changed, so a
 * modulated size or row range (data playhead) follows as fast as the worker can, without
 * queueing.
 *
 *   rows                          regroup in the worker (cached inputs; no rebuild)
 *   layout, size, innerRadius,
 *   padding                       re-lay out the worker's cached tree
 *   origin, colours, scale,
 *   domain, node size, links,
 *   opacity                       uniforms only
 *   labels                        troika members re-placed (text layout is async)
 *
 * Errors. Configuration problems (unknown column, a time level on a non-time column, a
 * non-numeric value column) throw from create(), so the layer is flagged straight away.
 * If the first job of a build fails there is nothing to show, so update() throws and the
 * layer is flagged with the worker's message. If a later job fails (re-layout or regroup),
 * the last good layout keeps drawing and the failure is logged; the same parameters are
 * not retried until they change. Either way the output never goes dark.
 *
 * Colour and node size use the layer's scale. An auto domain is per depth for sums and
 * row counts, and the leaves' range otherwise (see hierarchyDomainInto). Nodes whose value
 * is missing are drawn in a neutral grey at the smallest node size, never as a number.
 * Labels are capped at MAX_LABELS, shallowest first, and the cap is logged.
 *
 * Geometry is in output px: x right from origin.x, y down from origin.y (the box's
 * top-left), at origin.z.
 */

export interface HierarchySource {
  table: Table;
  calendars: Record<string, CalendarFields>;
}

export interface HierarchyInstance extends LayerInstance {
  apply(layer: HierarchyLayer, cameraMode: '2d' | '3d'): void;
}

/** Most labels drawn per layer (troika lays out every label; more would swamp the frame). */
export const MAX_LABELS = 500;
/** Colour of nodes whose value is missing (shown as missing, never as a number). */
const MISSING_COLOUR = '#5f6368';
const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };
const COLOUR_BY_CODE = { value: 0, depth: 1, none: 2 } as const;

const common = /* glsl */ `
  #define MISSING_TEST -1.0e29
  uniform vec3 uOrigin;
  uniform float uColourBy;
  uniform vec3 uColour;
  uniform vec3 uMissingColour;
  uniform vec4 uScale; // z: scale type, w: quantise steps
  uniform vec2 uDomains[${MAX_DEPTH + 1}]; // scale domain per depth
  uniform float uReverse;
  uniform sampler2D uRamp;
  uniform float uMaxDepth;

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
    if (s.z == 3.0) return floor(clamp(n, 0.0, 0.99999) * s.w) / (s.w - 1.0);
    return clamp(n, 0.0, 1.0);
  }
  vec4 scaleAt(float depth) {
    int d = int(clamp(depth, 0.0, ${MAX_DEPTH.toFixed(1)}));
    return vec4(uDomains[d], uScale.z, uScale.w);
  }
  // Local box px (x right, y down from the top-left) -> output px (y up).
  vec3 boxToWorld(vec2 p) { return vec3(uOrigin.x + p.x, uOrigin.y - p.y, uOrigin.z); }
  vec3 nodeColour(float value, float depth) {
    if (uColourBy > 1.5) return uColour;
    float n;
    if (uColourBy > 0.5) {
      n = uMaxDepth > 0.0 ? depth / uMaxDepth : 0.0;
    } else {
      if (value < MISSING_TEST) return uMissingColour;
      n = norm(value, scaleAt(depth));
    }
    if (uReverse > 0.5) n = 1.0 - n;
    return texture2D(uRamp, vec2(n, 0.5)).rgb;
  }
`;

const fillFragment = /* glsl */ `
  uniform float uOpacity;
  uniform float uRound;
  varying vec3 vColour;
  varying vec2 vUv;
  void main() {
    float a = uOpacity;
    if (uRound > 0.5) {
      float r = length(vUv - 0.5);
      float aa = fwidth(r);
      a *= 1.0 - smoothstep(0.5 - aa, 0.5, r);
    }
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColour, a);
  }
`;

const hideGlsl = /* glsl */ `
  void hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColour = vec3(0.0);
    vUv = vec2(0.0);
  }
`;

/** Point-layout node markers: round, radius by value across nodeSize. */
const nodeVertex = /* glsl */ `
  ${common}
  attribute vec4 aNode; // x, y, value, depth (-1 hidden)
  uniform vec2 uNodeSize;
  varying vec3 vColour;
  varying vec2 vUv;
  ${hideGlsl}
  void main() {
    if (aNode.w < -0.5) { hide(); return; }
    float n = aNode.z < MISSING_TEST ? 0.0 : norm(aNode.z, scaleAt(aNode.w));
    float r = mix(uNodeSize.x, uNodeSize.y, n);
    if (r <= 0.0) { hide(); return; }
    vec3 p = boxToWorld(aNode.xy) + vec3(position.xy * 2.0 * r, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vUv = position.xy + 0.5;
    vColour = nodeColour(aNode.z, aNode.w);
  }
`;

/** Rects (icicle, treemap) and circles (pack, drawn round in their bounding box). */
const cellVertex = /* glsl */ `
  ${common}
  attribute vec4 aRect; // x0, y0, x1, y1
  attribute vec2 aVal;  // value, depth (-1 hidden)
  varying vec3 vColour;
  varying vec2 vUv;
  ${hideGlsl}
  void main() {
    if (aVal.y < -0.5) { hide(); return; }
    vec2 t = position.xy + 0.5;
    vec3 p = boxToWorld(mix(aRect.xy, aRect.zw, t));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vUv = t;
    vColour = nodeColour(aVal.x, aVal.y);
  }
`;

/** Sunburst: pre-tessellated arc vertices in angle x radius about the box centre. */
const arcVertex = /* glsl */ `
  ${common}
  attribute vec2 aArc; // angle (clockwise from 12 o'clock), radius
  attribute vec2 aVal; // value, depth
  uniform vec2 uCentre;
  varying vec3 vColour;
  varying vec2 vUv;
  void main() {
    vec2 local = uCentre + vec2(sin(aArc.x), -cos(aArc.x)) * aArc.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(boxToWorld(local), 1.0);
    vUv = vec2(0.5);
    vColour = nodeColour(aVal.x, aVal.y);
  }
`;

/** Links: screen-space segments uWidth px wide with round caps (as the line layer). */
const linkVertex = /* glsl */ `
  uniform vec3 uOrigin;
  uniform float uWidth;
  uniform vec2 uResolution;
  attribute vec4 aSeg; // x0, y0, x1, y1 in box px
  varying vec4 vLocal;

  vec3 boxToWorld(vec2 p) { return vec3(uOrigin.x + p.x, uOrigin.y - p.y, uOrigin.z); }

  void hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec4(0.0, 0.0, 1.0, 0.0);
  }

  void main() {
    if (uWidth <= 0.0) { hide(); return; }
    vec4 v0 = modelViewMatrix * vec4(boxToWorld(aSeg.xy), 1.0);
    vec4 v1 = modelViewMatrix * vec4(boxToWorld(aSeg.zw), 1.0);
    if (projectionMatrix[2][3] == -1.0) {
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
    float reach = 0.5 * uWidth + 1.0;
    bool atEnd = position.x > 0.5;
    float along = atEnd ? len + reach : -reach;
    float across = position.y * reach;
    vec2 s = s0 + dir * along + nrm * across;
    vec4 c = atEnd ? c1 : c0;
    gl_Position = vec4(s / halfRes * c.w, c.z, c.w);
    vLocal = vec4(vec2(along, across) * c.w, c.w, len);
  }
`;

const linkFragment = /* glsl */ `
  uniform vec3 uLinkColour;
  uniform float uLinkOpacity;
  uniform float uWidth;
  varying vec4 vLocal;
  void main() {
    vec2 p = vLocal.xy / vLocal.z;
    float len = vLocal.w;
    float d = p.x < 0.0 ? length(p) : (p.x > len ? length(vec2(p.x - len, p.y)) : abs(p.y));
    float a = clamp(0.5 * uWidth - d + 0.5, 0.0, 1.0) * uLinkOpacity;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(uLinkColour, a);
  }
`;

/** A unit quad centred on 0 (corners at +-0.5), for nodes and cells. */
function centredQuad(geometry: BufferGeometry): void {
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
}

/** Wanted (or shown) job parameters, compared field by field so apply() never allocates. */
interface JobParams {
  first: number;
  last: number;
  layout: HierarchyLayoutName;
  width: number;
  height: number;
  innerRadius: number;
  padding: number;
}

function sameParams(a: JobParams, b: JobParams): boolean {
  return (
    a.first === b.first &&
    a.last === b.last &&
    a.layout === b.layout &&
    a.width === b.width &&
    a.height === b.height &&
    a.innerRadius === b.innerRadius &&
    a.padding === b.padding
  );
}

function copyParams(to: JobParams, from: JobParams): void {
  to.first = from.first;
  to.last = from.last;
  to.layout = from.layout;
  to.width = from.width;
  to.height = from.height;
  to.innerRadius = from.innerRadius;
  to.padding = from.padding;
}

function blankParams(): JobParams {
  return { first: -1, last: -1, layout: 'dendrogram', width: NaN, height: NaN, innerRadius: NaN, padding: NaN };
}

let inputCounter = 0;

export function createHierarchy(
  layer: HierarchyLayer,
  source: HierarchySource,
  cameraMode: '2d' | '3d',
  client: HierarchyClient = hierarchyClient(),
): HierarchyInstance {
  const root = new Group();
  root.name = layer.name;
  const prepared: GroupInputs | null = prepareHierarchyInputs(layer, source.table, source.calendars);
  if (!prepared) {
    // Not configured yet (a level without a column): draw nothing.
    return { object: root, apply: (next) => void (root.name = next.name), update() {}, dispose() {} };
  }
  const inputs: GroupInputs = prepared;
  const rowCount = source.table.rowCount;
  const inputKey = `hierarchy-${++inputCounter}`;
  const aggregate = layer.aggregate;
  let layerName = layer.name;

  // ---- materials (live for the whole instance; geometry is swapped per layout) ----

  const colourUniforms: Record<string, IUniform> = {
    uOrigin: { value: new Vector3() },
    uColourBy: { value: 0 },
    uColour: { value: new Color() },
    uMissingColour: { value: new Color(MISSING_COLOUR) },
    uScale: { value: new Vector4(0, 1, 0, layer.steps) },
    uDomains: { value: Array.from({ length: MAX_DEPTH + 1 }, () => new Vector2(0, 1)) },
    uReverse: { value: 0 },
    uRamp: { value: rampTexture(layer.ramp) },
    uMaxDepth: { value: 1 },
    uOpacity: { value: 1 },
  };
  const nodeMaterial = new ShaderMaterial({
    vertexShader: nodeVertex,
    fragmentShader: fillFragment,
    uniforms: { ...colourUniforms, uNodeSize: { value: new Vector2() }, uRound: { value: 1 } },
    side: DoubleSide,
    transparent: true,
  });
  const cellMaterial = new ShaderMaterial({
    vertexShader: cellVertex,
    fragmentShader: fillFragment,
    uniforms: { ...colourUniforms, uRound: { value: 0 } },
    side: DoubleSide,
  });
  const arcMaterial = new ShaderMaterial({
    vertexShader: arcVertex,
    fragmentShader: fillFragment,
    uniforms: { ...colourUniforms, uCentre: { value: new Vector2() }, uRound: { value: 0 } },
    side: DoubleSide,
  });
  const linkMaterial = new ShaderMaterial({
    vertexShader: linkVertex,
    fragmentShader: linkFragment,
    uniforms: {
      uOrigin: colourUniforms.uOrigin!,
      uWidth: { value: 2 },
      uResolution: { value: new Vector2(OUTPUT_WIDTH, OUTPUT_HEIGHT) },
      uLinkColour: { value: new Color() },
      uLinkOpacity: { value: 1 },
    },
    side: DoubleSide,
    transparent: true,
  });
  const materials = [nodeMaterial, cellMaterial, arcMaterial, linkMaterial];

  function mesh(material: ShaderMaterial, order: number): Mesh {
    const m = new Mesh(new BufferGeometry(), material);
    m.frustumCulled = false;
    m.visible = false;
    m.renderOrder = order;
    root.add(m);
    return m;
  }
  // Links under nodes, labels on top.
  const linkMesh = mesh(linkMaterial, 0);
  const nodeMesh = mesh(nodeMaterial, 1);
  const cellMesh = mesh(cellMaterial, 1);
  const arcMesh = mesh(arcMaterial, 1);

  function setGeometry(m: Mesh, geometry: BufferGeometry | null): void {
    const old = m.geometry;
    m.geometry = geometry ?? new BufferGeometry();
    m.visible = geometry !== null;
    old.dispose();
  }

  // ---- labels ----

  const labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const labels = new BatchedText();
  labels.material = labelMaterial;
  labels.frustumCulled = false;
  labels.renderOrder = 2;
  labels.visible = false;
  root.add(labels);
  const pool: Text[] = [];
  let labelOrder: Int32Array = new Int32Array(0); // candidate nodes, shallowest first
  let labelCandidates = 0;
  let cappedWarned = '';

  // ---- job state ----

  const wanted = blankParams();
  const shown = blankParams();
  const requested = blankParams();
  const failed = blankParams();
  let inFlight = false;
  let firstFailures = 0;
  let disposed = false;
  let fatal: Error | null = null;
  // `tree` and `layout` are what is drawn. A result is held in `pending` (with its tree)
  // until update() swaps both in together; `arrived` is the newest tree received, keyed by
  // `treeKey`, so the next job knows whether it needs the tree sent again.
  let tree: HierarchyTree | null = null;
  let layout: HierarchyLayoutResult | null = null;
  let arrived: HierarchyTree | null = null;
  let treeKey = '';
  let pending: HierarchyLayoutResult | null = null;
  let pendingTree: HierarchyTree | null = null;
  let pendingParams = blankParams();
  let treeVersion = 0;

  // Applied state, for change detection.
  let current: HierarchyLayer = layer;
  let stats: DepthStats | null = null;
  const domainScratch = [0, 1];
  let domainVersion = -1;
  // Labels are re-placed only when the layout or a label setting changed.
  let labelsDirty = true;
  let placedDepth = NaN;
  let placedSize = NaN;
  let placedGap = NaN;
  let placedFont = '';
  let placedUppercase = false;

  function schedule(): void {
    if (inFlight || disposed || fatal) return;
    if (sameParams(wanted, shown) && !pending) return;
    if (pending && sameParams(wanted, pendingParams)) return;
    if (sameParams(wanted, failed)) return;
    copyParams(requested, wanted);
    const job = { ...requested };
    const groupKey = `${inputKey}|${job.first}|${job.last}`;
    inFlight = true;
    client
      .run({
        inputKey,
        inputs: () => inputs,
        groupKey,
        aggregate,
        first: job.first,
        last: job.last,
        wantTree: treeKey !== groupKey,
        layout: { layout: job.layout, width: job.width, height: job.height, innerRadius: job.innerRadius, padding: job.padding },
      })
      .then((res) => {
        if (disposed) return;
        if (res.tree) {
          arrived = res.tree;
          treeKey = groupKey;
        }
        if (!arrived || res.layout.nodeCount !== arrived.nodeCount) throw new Error('layout does not match its tree');
        pending = res.layout;
        pendingTree = arrived;
        pendingParams = job;
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        if (!layout && !pending) {
          // Nothing to show yet. One retry covers a worker that crashed or timed out for
          // reasons of its own (it is replaced); a second failure flags the layer.
          if (++firstFailures >= 2) fatal = new Error(`hierarchy layout failed: ${message}`);
          else console.warn(`hierarchy layer "${layerName}": layout failed, retrying once: ${message}`);
        } else {
          copyParams(failed, job);
          console.warn(`hierarchy layer "${layerName}": layout failed, keeping the last good one: ${message}`);
        }
      })
      .finally(() => {
        inFlight = false;
        if (!disposed) schedule();
      });
  }

  /** Swap a finished layout in (from update(), inside the LayerHost fence). */
  function swap(next: HierarchyLayoutResult, nextTree: HierarchyTree): void {
    if (nextTree !== tree) {
      tree = nextTree;
      treeVersion++;
    }
    const t = nextTree;
    layout = next;
    copyParams(shown, pendingParams);

    setGeometry(nodeMesh, null);
    setGeometry(cellMesh, null);
    setGeometry(arcMesh, null);
    setGeometry(linkMesh, null);
    if (next.shape === 'points') {
      const g = new InstancedBufferGeometry();
      centredQuad(g);
      g.setAttribute('aNode', new InstancedBufferAttribute(next.nodes, NODE_STRIDE));
      g.instanceCount = next.nodeCount;
      setGeometry(nodeMesh, g);
      const segments = next.segments.length / 4;
      if (segments > 0) {
        const lg = new InstancedBufferGeometry();
        lg.setAttribute('position', new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
        lg.setIndex([0, 1, 2, 0, 2, 3]);
        lg.setAttribute('aSeg', new InstancedBufferAttribute(next.segments, 4));
        lg.instanceCount = segments;
        setGeometry(linkMesh, lg);
      }
    } else if (next.shape === 'arcs') {
      if (next.arcIndex.length > 0) {
        const g = new BufferGeometry();
        const buffer = new InterleavedBuffer(next.arcVertices, ARC_VERTEX_STRIDE);
        g.setAttribute('aArc', new InterleavedBufferAttribute(buffer, 2, 0));
        g.setAttribute('aVal', new InterleavedBufferAttribute(buffer, 2, 2));
        g.setIndex(new BufferAttribute(next.arcIndex, 1));
        setGeometry(arcMesh, g);
      }
      (arcMaterial.uniforms.uCentre!.value as Vector2).set(next.cx, next.cy);
    } else {
      const g = new InstancedBufferGeometry();
      centredQuad(g);
      const buffer = new InstancedInterleavedBuffer(next.cells, CELL_STRIDE, 1);
      g.setAttribute('aRect', new InterleavedBufferAttribute(buffer, 4, 0));
      g.setAttribute('aVal', new InterleavedBufferAttribute(buffer, 2, 4));
      g.instanceCount = next.nodeCount;
      setGeometry(cellMesh, g);
      cellMaterial.uniforms.uRound!.value = next.shape === 'circles' ? 1 : 0;
    }

    if (domainVersion !== treeVersion) {
      domainVersion = treeVersion;
      stats = depthStats(t);
      colourUniforms.uMaxDepth!.value = Math.max(1, t.levels);
      if (t.missingTotal > 0 || t.ungrouped > 0) {
        console.info(
          `hierarchy layer "${layerName}": ${t.missingTotal} rows with a missing value left out of the totals` +
            (t.ungrouped > 0 ? `, ${t.ungrouped} rows with no ${t.levels > 1 ? 'group keys' : 'group key'} not placed` : ''),
        );
      }
    }
    labelOrder = labelCandidatesOf(t, labelOrder);
    labelsDirty = true;
    apply(current, mode);
  }

  /** All nodes in depth order (root first), reusing `into` when it is big enough. */
  function labelCandidatesOf(t: HierarchyTree, into: Int32Array): Int32Array {
    const out = into.length >= t.nodeCount ? into : new Int32Array(t.nodeCount);
    let k = 0;
    for (let d = 0; d <= t.levels; d++) for (let i = 0; i < t.nodeCount; i++) if (t.depth[i] === d) out[k++] = i;
    labelCandidates = k;
    return out;
  }

  /** Scale type and the domain per depth (see hierarchyDomainInto). */
  function setScaleUniform(next: HierarchyLayer): void {
    (colourUniforms.uScale!.value as Vector4).set(0, 1, SCALE_CODE[next.scale], next.steps);
    const domains = colourUniforms.uDomains!.value as Vector2[];
    for (let d = 0; d <= MAX_DEPTH; d++) {
      if (tree && stats) hierarchyDomainInto(domainScratch, tree, stats, next.scale, next.domain, d);
      else {
        domainScratch[0] = next.domain?.[0] ?? 0;
        domainScratch[1] = next.domain?.[1] ?? 1;
      }
      domains[d]!.set(domainScratch[0]!, domainScratch[1]!);
    }
  }

  function labelText(i: number): Text {
    let text = pool[i];
    if (!text) {
      text = new Text();
      text.text = '';
      text.whiteSpace = 'nowrap';
      pool.push(text);
      labels.addText(text);
    }
    return text;
  }

  /** Place labels for the shown layout (only when the layout or a label setting changed). */
  function placeLabels(next: HierarchyLayer): void {
    const t = tree;
    const l = layout;
    const gap = Math.max(0, next.nodeSize[1]) + 6;
    if (
      !labelsDirty &&
      placedDepth === next.labelDepth &&
      placedSize === next.labelSize &&
      placedGap === gap &&
      placedFont === next.labelFont &&
      placedUppercase === next.labelUppercase
    ) {
      return;
    }
    labelsDirty = false;
    placedFont = next.labelFont;
    placedUppercase = next.labelUppercase;
    placedDepth = next.labelDepth;
    placedSize = next.labelSize;
    placedGap = gap;
    let used = 0;
    let wantedCount = 0;
    if (t && l && next.labelDepth >= 0) {
      const size = next.labelSize;
      for (let k = 0; k < labelCandidates; k++) {
        const i = labelOrder[k]!;
        if (t.depth[i]! > next.labelDepth) break;
        // Treemap cells share their top-left corner with their first child, so only the
        // deepest labelled level is labelled.
        if (l.layout === 'treemap' && t.depth[i]! < Math.min(next.labelDepth, t.levels)) continue;
        if (!l.visible[i] && !(l.layout === 'radial-dendrogram' && i === 0)) continue;
        if (!labelFits(l, i, size)) continue;
        wantedCount++;
        if (used >= MAX_LABELS) continue;
        placeLabel(labelText(used++), t, l, i, size, gap, next);
      }
    }
    for (let j = used; j < pool.length; j++) pool[j]!.text = '';
    labels.visible = used > 0;
    const capKey = `${treeVersion}|${wantedCount}`;
    if (wantedCount > MAX_LABELS && cappedWarned !== capKey) {
      cappedWarned = capKey;
      console.warn(`hierarchy layer "${layerName}": showing ${MAX_LABELS} of ${wantedCount} labels (the label limit); lower the label depth`);
    }
  }

  function labelFits(l: HierarchyLayoutResult, i: number, size: number): boolean {
    const b = i * 4;
    switch (l.shape) {
      case 'points':
        return true;
      case 'arcs': {
        if (i === 0) return true;
        const span = (l.bounds[b + 1]! - l.bounds[b]!) * ((l.bounds[b + 2]! + l.bounds[b + 3]!) / 2);
        return span >= size * 1.2 && l.bounds[b + 3]! - l.bounds[b + 2]! >= size * 1.2;
      }
      case 'circles':
        return l.radius[i]! * 2 >= size * 1.5;
      case 'rects':
        return l.bounds[b + 2]! - l.bounds[b]! >= size * 1.5 && l.bounds[b + 3]! - l.bounds[b + 1]! >= size * 1.2;
    }
  }

  function placeLabel(text: Text, t: HierarchyTree, l: HierarchyLayoutResult, i: number, size: number, gap: number, next: HierarchyLayer): void {
    text.text = displayText(t.labels[t.label[i]!] ?? '', next.labelUppercase);
    text.font = fontUrl(next.labelFont);
    text.fontSize = size;
    let x = l.x[i]!;
    let y = l.y[i]!;
    let rotation = 0;
    let anchorX: 'left' | 'center' | 'right' = 'center';
    let anchorY: 'top' | 'middle' | 'bottom' = 'middle';
    let clip: [number, number, number, number] | null = null;
    const b = i * 4;
    const isLeaf = t.depth[i] === t.levels;
    switch (l.layout) {
      case 'dendrogram':
      case 'tree':
        if (isLeaf) {
          anchorX = 'left';
          x += gap;
        } else {
          // Above and left of the node, clear of the link arriving from its parent.
          anchorX = 'right';
          anchorY = 'bottom';
          x -= 4;
          y -= 4;
        }
        break;
      case 'radial-dendrogram':
        if (i !== 0) {
          // Outward along the spoke, flipped on the left half so it never reads upside down.
          const a = l.angle[i]!;
          const flip = Math.sin(a) < 0;
          rotation = Math.PI / 2 - a + (flip ? Math.PI : 0);
          anchorX = flip ? 'right' : 'left';
          x = l.cx + Math.sin(a) * (l.radius[i]! + gap);
          y = l.cy - Math.cos(a) * (l.radius[i]! + gap);
        }
        break;
      case 'sunburst':
        break;
      case 'pack':
        if (!isLeaf) {
          anchorY = 'top';
          y = l.y[i]! - l.radius[i]! + 4;
        }
        break;
      case 'icicle':
      case 'treemap': {
        const w = l.bounds[b + 2]! - l.bounds[b]!;
        const h = l.bounds[b + 3]! - l.bounds[b + 1]!;
        anchorX = 'left';
        anchorY = 'top';
        x = l.bounds[b]! + 4;
        y = l.bounds[b + 1]! + 4;
        clip = [0, -(h - 8), w - 8, 0];
        break;
      }
    }
    text.anchorX = anchorX;
    text.anchorY = anchorY;
    text.clipRect = clip;
    text.position.set(x, -y, 0);
    text.rotation.z = rotation;
  }

  let mode = cameraMode;

  function blendMode(m: ShaderMaterial, edges: boolean, translucent: boolean, additive: boolean): void {
    m.transparent = edges || translucent;
    m.blending = additive ? AdditiveBlending : NormalBlending;
    m.depthTest = mode === '3d' && !additive;
    m.depthWrite = mode === '3d' && !m.transparent;
  }

  function apply(next: HierarchyLayer, cameraModeNow: '2d' | '3d'): void {
    current = next;
    mode = cameraModeNow;
    layerName = next.name;
    root.name = next.name;

    // Job parameters: regroup for rows, re-lay out for the layout fields that matter.
    // As rowRange() in line-data.ts, inlined so a modulated apply() allocates nothing.
    wanted.first = Math.max(0, Math.floor(Math.min(next.rows[0], next.rows[1]) * rowCount));
    wanted.last = Math.min(rowCount - 1, Math.ceil(Math.max(next.rows[0], next.rows[1]) * rowCount) - 1);
    wanted.layout = next.layout;
    wanted.width = next.size[0];
    wanted.height = next.size[1];
    wanted.innerRadius = usesInnerRadius(next.layout) ? next.innerRadius : 0;
    wanted.padding = usesPadding(next.layout) ? next.padding : 0;
    schedule();

    (colourUniforms.uOrigin!.value as Vector3).fromArray(next.origin);
    colourUniforms.uColourBy!.value = COLOUR_BY_CODE[next.colourBy];
    (colourUniforms.uColour!.value as Color).set(next.colour);
    setScaleUniform(next);
    colourUniforms.uReverse!.value = next.reverse ? 1 : 0;
    colourUniforms.uRamp!.value = rampTexture(next.ramp);
    colourUniforms.uOpacity!.value = next.opacity;
    (nodeMaterial.uniforms.uNodeSize!.value as Vector2).set(Math.max(0, next.nodeSize[0]), Math.max(0, next.nodeSize[1]));
    linkMaterial.uniforms.uWidth!.value = next.linkWidth;
    (linkMaterial.uniforms.uLinkColour!.value as Color).set(next.linkColour);
    linkMaterial.uniforms.uLinkOpacity!.value = next.linkOpacity * next.opacity;

    placeLabels(next);
    labels.position.set(next.origin[0], next.origin[1], next.origin[2]);
    for (let j = 0; j < pool.length; j++) {
      const text = pool[j]!;
      text.color = next.labelColour;
      text.fillOpacity = next.opacity;
    }

    // Depth and blending as the other layers: in 2D draw order decides; in 3D test depth
    // and write it only when opaque.
    const additive = next.blend === 'additive';
    const translucent = additive || next.opacity < 1;
    // Round markers, circles and links have anti-aliased edges, so they always blend.
    blendMode(nodeMaterial, true, translucent, additive);
    blendMode(linkMaterial, true, translucent, additive);
    blendMode(cellMaterial, layout?.shape === 'circles', translucent, additive);
    blendMode(arcMaterial, false, translucent, additive);
    labelMaterial.blending = additive ? AdditiveBlending : NormalBlending;
    labelMaterial.depthTest = mode === '3d' && !additive;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {
      if (fatal) throw fatal;
      if (pending && pendingTree) {
        const next = pending;
        const nextTree = pendingTree;
        pending = null;
        pendingTree = null;
        swap(next, nextTree);
      }
    },
    dispose() {
      disposed = true;
      client.drop(inputKey);
      for (const m of [linkMesh, nodeMesh, cellMesh, arcMesh]) m.geometry.dispose();
      for (const m of materials) m.dispose();
      for (const text of pool) {
        labels.removeText(text);
        text.dispose();
      }
      labels.dispose();
      labelMaterial.dispose();
    },
  };
}
