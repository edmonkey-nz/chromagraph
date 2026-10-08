/**
 * Layouts for hierarchy layers: a grouped tree (hierarchy-data.ts) is laid out with
 * d3-hierarchy into flat typed arrays. Pure and worker-safe; it runs in the hierarchy
 * worker and is unit-tested.
 *
 * Coordinates are local px in the layer's box: x right and y DOWN from the box's top-left
 * corner (the renderer places the box at `origin`, flipping y into the output's y-up space).
 *
 *   dendrogram          d3.cluster, root on the left, leaves aligned on the right
 *   tree                d3.tree, root on the left
 *   radial-dendrogram   d3.cluster in angle x radius, centred in the box: the root sits at
 *                       the centre and the levels run from `innerRadius` (or one ring out
 *                       when it is 0) to the box's min half-size
 *   sunburst            d3.partition in angle x radius, from `innerRadius` to the min half-size
 *   icicle              d3.partition, root on the left
 *   pack                d3.pack (circles)
 *   treemap             d3.treemap with squarified tiles
 *
 * Angles are radians clockwise from 12 o'clock. `padding` (px) separates cells in the area
 * layouts; cells smaller than the padding collapse and are not drawn, as in d3.
 *
 * Area layouts size leaves by their value when the tree sums values or counts rows
 * (`sizeByValue`); negative, zero and missing values get no area. Other aggregates (a
 * mean, min, max or last has no meaningful sum) size leaves by their number of rows, so the
 * area shows how much data there is and the colour shows the value.
 */
import {
  cluster,
  hierarchy,
  pack,
  partition,
  tree as tidyTree,
  treemap,
  treemapSquarify,
  type HierarchyNode,
} from 'd3-hierarchy';
import type { HIERARCHY_LAYOUTS } from '../shared/layer-schema.ts';
import type { HierarchyTree } from './hierarchy-data.ts';
import { MISSING } from './instance-data.ts';

export type HierarchyLayoutName = (typeof HIERARCHY_LAYOUTS)[number];
export type LayoutShape = 'points' | 'rects' | 'circles' | 'arcs';

export interface LayoutParams {
  layout: HierarchyLayoutName;
  width: number;
  height: number;
  innerRadius: number;
  padding: number;
}

/** Floats per node in `nodes` (point layouts): x, y, value, depth. */
export const NODE_STRIDE = 4;
/** Floats per node in `cells` (rects and circles): x0, y0, x1, y1, value, depth. */
export const CELL_STRIDE = 6;
/** Floats per vertex in `arcVertices`: angle, radius, value, depth. */
export const ARC_VERTEX_STRIDE = 4;
/** Sunburst tessellation: quads per degree of arc. */
export const QUADS_PER_DEGREE = 3;

export interface HierarchyLayoutResult {
  layout: HierarchyLayoutName;
  shape: LayoutShape;
  nodeCount: number;
  /** Anchor per node: point position, cell centre or arc centroid. */
  x: Float32Array;
  y: Float32Array;
  /** Radial layouts: polar angle per node. */
  angle: Float32Array;
  /** Radial layouts: polar radius per node; pack: circle radius. */
  radius: Float32Array;
  /** 1 where the node is drawn, 0 where it is hidden or collapsed. */
  visible: Uint8Array;
  /** Area layouts, 4 per node: x0 y0 x1 y1 (rects; circles' bounding boxes) or a0 a1 r0 r1 (arcs). */
  bounds: Float32Array;
  /** Point layouts: parent, child per link. */
  links: Uint32Array;
  /** Point layouts: link geometry, x0 y0 x1 y1 per straight segment (elbows expanded). */
  segments: Float32Array;
  /** Radial layouts: centre in local px. */
  cx: number;
  cy: number;
  /** GPU-ready per-node data for point layouts (see NODE_STRIDE); depth -1 hides a node. */
  nodes: Float32Array;
  /** GPU-ready per-node data for rects and circles (see CELL_STRIDE); depth -1 hides a node. */
  cells: Float32Array;
  /** Sunburst triangles (see ARC_VERTEX_STRIDE) and their indices. */
  arcVertices: Float32Array;
  arcIndex: Uint32Array;
}

export function layoutShape(layout: HierarchyLayoutName): LayoutShape {
  switch (layout) {
    case 'dendrogram':
    case 'tree':
    case 'radial-dendrogram':
      return 'points';
    case 'sunburst':
      return 'arcs';
    case 'pack':
      return 'circles';
    case 'icicle':
    case 'treemap':
      return 'rects';
  }
}

/** True for layouts that use `innerRadius`. */
export function usesInnerRadius(layout: HierarchyLayoutName): boolean {
  return layout === 'radial-dendrogram' || layout === 'sunburst';
}

/** True for layouts that use `padding`. */
export function usesPadding(layout: HierarchyLayoutName): boolean {
  return layoutShape(layout) !== 'points';
}

export function layoutTransferables(r: HierarchyLayoutResult): ArrayBuffer[] {
  return [r.x, r.y, r.angle, r.radius, r.visible, r.bounds, r.links, r.segments, r.nodes, r.cells, r.arcVertices, r.arcIndex].map(
    (a) => a.buffer as ArrayBuffer,
  );
}

function childLists(tree: HierarchyTree): number[][] {
  const kids: number[][] = [];
  for (let i = 0; i < tree.nodeCount; i++) kids.push([]);
  for (let i = 1; i < tree.nodeCount; i++) kids[tree.parent[i]!]!.push(i);
  return kids;
}

function leafSize(tree: HierarchyTree, i: number): number {
  if (tree.sizeByValue) {
    const v = tree.value[i]!;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  return tree.count[i]! + tree.missing[i]!;
}

const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** Lay out `tree` per `params`. Degenerate sizes give an empty-looking but valid result. */
export function layoutHierarchy(tree: HierarchyTree, params: LayoutParams): HierarchyLayoutResult {
  const n = tree.nodeCount;
  const width = Math.max(1, finite(params.width));
  const height = Math.max(1, finite(params.height));
  const padding = Math.max(0, finite(params.padding));
  const shape = layoutShape(params.layout);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const angle = new Float32Array(n);
  const radius = new Float32Array(n);
  const visible = new Uint8Array(n).fill(1);
  const bounds = new Float32Array(shape === 'points' ? 0 : n * 4);
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) / 2;
  const inner = Math.min(Math.max(0, finite(params.innerRadius)), R);

  const kids = childLists(tree);
  const root: HierarchyNode<number> = hierarchy<number>(0, (i) => (kids[i]!.length ? kids[i] : undefined));

  switch (params.layout) {
    case 'dendrogram':
    case 'tree': {
      const lay = params.layout === 'tree' ? tidyTree<number>() : cluster<number>();
      lay.size([height, width]);
      lay(root).each((node) => {
        x[node.data] = finite(node.y);
        y[node.data] = finite(node.x);
      });
      break;
    }
    case 'radial-dendrogram': {
      const lay = cluster<number>()
        .size([2 * Math.PI, 1])
        .separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth));
      const laid = lay(root);
      // The levels run from the first ring to R. The first ring is innerRadius, or one
      // ring's step out from the centre when that is 0 (so level 1 is not on the root).
      let fMin = 1;
      for (const c of laid.children ?? []) fMin = Math.min(fMin, c.y);
      const levels = Math.max(1, tree.levels);
      const ringStart = inner > 0 ? inner : R / (levels + 1);
      laid.each((node) => {
        const i = node.data;
        const a = finite(node.x);
        const r = node.depth === 0 ? 0 : fMin < 1 ? ringStart + ((node.y - fMin) / (1 - fMin)) * (R - ringStart) : R;
        angle[i] = a;
        radius[i] = finite(r);
        x[i] = cx + Math.sin(a) * radius[i]!;
        y[i] = cy - Math.cos(a) * radius[i]!;
      });
      // The root is the centre; with an inner radius the centre stays clear.
      if (inner > 0) visible[0] = 0;
      break;
    }
    case 'sunburst': {
      root.sum((i) => (kids[i]!.length ? 0 : leafSize(tree, i)));
      partition<number>().size([2 * Math.PI, 1])(root).each((node) => {
        const i = node.data;
        let a0 = finite(node.x0);
        let a1 = finite(node.x1);
        let r0 = inner + finite(node.y0) * (R - inner);
        let r1 = inner + finite(node.y1) * (R - inner);
        if (padding > 0) {
          r0 += padding / 2;
          r1 -= padding / 2;
          // A full ring keeps its full turn; any other arc is inset by half the padding at
          // its mid radius on each side.
          if (a1 - a0 < 2 * Math.PI - 1e-9) {
            const da = padding / 2 / Math.max(1, (r0 + r1) / 2);
            a0 += da;
            a1 -= da;
          }
        }
        if (!(a1 > a0) || !(r1 > r0)) visible[i] = 0;
        const b = i * 4;
        bounds[b] = a0;
        bounds[b + 1] = Math.max(a0, a1);
        bounds[b + 2] = r0;
        bounds[b + 3] = Math.max(r0, r1);
        const full = a1 - a0 >= 2 * Math.PI - 1e-6;
        const am = (a0 + a1) / 2;
        const rm = full && r0 <= inner + padding ? 0 : (r0 + r1) / 2;
        angle[i] = am;
        radius[i] = rm;
        x[i] = cx + Math.sin(am) * rm;
        y[i] = cy - Math.cos(am) * rm;
      });
      break;
    }
    case 'icicle': {
      root.sum((i) => (kids[i]!.length ? 0 : leafSize(tree, i)));
      partition<number>().size([height, width]).padding(padding)(root).each((node) => {
        setRect(node.data, finite(node.y0), finite(node.x0), finite(node.y1), finite(node.x1));
      });
      break;
    }
    case 'treemap': {
      root.sum((i) => (kids[i]!.length ? 0 : leafSize(tree, i)));
      treemap<number>().tile(treemapSquarify).size([width, height]).padding(padding).round(false)(root).each((node) => {
        setRect(node.data, finite(node.x0), finite(node.y0), finite(node.x1), finite(node.y1));
      });
      break;
    }
    case 'pack': {
      root.sum((i) => (kids[i]!.length ? 0 : leafSize(tree, i)));
      pack<number>().size([width, height]).padding(padding)(root).each((node) => {
        const i = node.data;
        const r = finite(node.r);
        const px = finite(node.x);
        const py = finite(node.y);
        x[i] = px;
        y[i] = py;
        radius[i] = r;
        const b = i * 4;
        bounds[b] = px - r;
        bounds[b + 1] = py - r;
        bounds[b + 2] = px + r;
        bounds[b + 3] = py + r;
        if (!(r > 0)) visible[i] = 0;
      });
      break;
    }
  }

  function setRect(i: number, x0: number, y0: number, x1: number, y1: number): void {
    const b = i * 4;
    bounds[b] = x0;
    bounds[b + 1] = y0;
    bounds[b + 2] = Math.max(x0, x1);
    bounds[b + 3] = Math.max(y0, y1);
    x[i] = (x0 + x1) / 2;
    y[i] = (y0 + y1) / 2;
    if (!(x1 > x0) || !(y1 > y0)) visible[i] = 0;
  }

  // Links and their geometry (point layouts).
  let links: Uint32Array = new Uint32Array(0);
  let segments: Float32Array = new Float32Array(0);
  if (shape === 'points') {
    links = new Uint32Array(Math.max(0, n - 1) * 2);
    for (let i = 1; i < n; i++) {
      links[(i - 1) * 2] = tree.parent[i]!;
      links[(i - 1) * 2 + 1] = i;
    }
    segments = params.layout === 'radial-dendrogram' ? radialSegments(tree, x, y, angle, inner, cx, cy) : elbowSegments(kids, x, y);
  }

  const result: HierarchyLayoutResult = {
    layout: params.layout,
    shape,
    nodeCount: n,
    x,
    y,
    angle,
    radius,
    visible,
    bounds,
    links,
    segments,
    cx,
    cy,
    nodes: new Float32Array(0),
    cells: new Float32Array(0),
    arcVertices: new Float32Array(0),
    arcIndex: new Uint32Array(0),
  };
  packForGpu(tree, result);
  return result;
}

/**
 * Right-angled dendrogram links: per parent a bracket along its children (vertical, at
 * the parent's x) and per child a run across to it. Zero-length pieces are left out.
 */
function elbowSegments(kids: number[][], x: Float32Array, y: Float32Array): Float32Array {
  const out: number[] = [];
  for (let p = 0; p < kids.length; p++) {
    const children = kids[p]!;
    if (children.length === 0) continue;
    const px = x[p]!;
    let lo = y[p]!;
    let hi = y[p]!;
    for (const c of children) {
      const cyv = y[c]!;
      if (cyv < lo) lo = cyv;
      if (cyv > hi) hi = cyv;
      if (Math.abs(x[c]! - px) > 1e-3) out.push(px, cyv, x[c]!, cyv);
    }
    if (hi - lo > 1e-3) out.push(px, lo, px, hi);
  }
  return Float32Array.from(out);
}

/**
 * Straight radial spokes from parent to child. The root's spokes start at the inner radius
 * (on the child's angle) so the centre stays clear.
 */
function radialSegments(
  tree: HierarchyTree,
  x: Float32Array,
  y: Float32Array,
  angle: Float32Array,
  inner: number,
  cx: number,
  cy: number,
): Float32Array {
  const out: number[] = [];
  for (let i = 1; i < tree.nodeCount; i++) {
    const p = tree.parent[i]!;
    let x0 = x[p]!;
    let y0 = y[p]!;
    if (p === 0) {
      x0 = cx + Math.sin(angle[i]!) * inner;
      y0 = cy - Math.cos(angle[i]!) * inner;
    }
    if (Math.hypot(x[i]! - x0, y[i]! - y0) > 1e-3) out.push(x0, y0, x[i]!, y[i]!);
  }
  return Float32Array.from(out);
}

const gpuValue = (v: number) => (Number.isFinite(v) ? v : MISSING);

/** Fill the GPU-ready arrays of a result. */
function packForGpu(tree: HierarchyTree, r: HierarchyLayoutResult): void {
  const n = r.nodeCount;
  if (r.shape === 'points') {
    const nodes = new Float32Array(n * NODE_STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * NODE_STRIDE;
      nodes[o] = r.x[i]!;
      nodes[o + 1] = r.y[i]!;
      nodes[o + 2] = gpuValue(tree.value[i]!);
      nodes[o + 3] = r.visible[i] ? tree.depth[i]! : -1;
    }
    r.nodes = nodes;
  } else if (r.shape === 'arcs') {
    tessellateArcs(tree, r);
  } else {
    const cells = new Float32Array(n * CELL_STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * CELL_STRIDE;
      cells.set(r.bounds.subarray(i * 4, i * 4 + 4), o);
      cells[o + 4] = gpuValue(tree.value[i]!);
      cells[o + 5] = r.visible[i] ? tree.depth[i]! : -1;
    }
    r.cells = cells;
  }
}

/** Quads used for an arc of `span` radians. */
export function arcQuads(span: number): number {
  return Math.max(1, Math.ceil(((span * 180) / Math.PI) * QUADS_PER_DEGREE));
}

/**
 * Sunburst arcs as indexed triangles, QUADS_PER_DEGREE quads per degree of arc (at least
 * one per arc), so even a full ring stays round at 1080p while a day-sized sliver costs a
 * single quad. Hidden arcs are left out.
 */
export function tessellateArcs(tree: HierarchyTree, r: HierarchyLayoutResult): void {
  const n = r.nodeCount;
  let quads = 0;
  for (let i = 0; i < n; i++) if (r.visible[i]) quads += arcQuads(r.bounds[i * 4 + 1]! - r.bounds[i * 4]!);
  const vertices = new Float32Array((quads + n) * 2 * ARC_VERTEX_STRIDE);
  const index = new Uint32Array(quads * 6);
  let v = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!r.visible[i]) continue;
    const b = i * 4;
    const a0 = r.bounds[b]!;
    const a1 = r.bounds[b + 1]!;
    const r0 = r.bounds[b + 2]!;
    const r1 = r.bounds[b + 3]!;
    const q = arcQuads(a1 - a0);
    const value = gpuValue(tree.value[i]!);
    const depth = tree.depth[i]!;
    const start = v;
    for (let s = 0; s <= q; s++) {
      const a = a0 + ((a1 - a0) * s) / q;
      for (let side = 0; side < 2; side++) {
        const o = v * ARC_VERTEX_STRIDE;
        vertices[o] = a;
        vertices[o + 1] = side === 0 ? r0 : r1;
        vertices[o + 2] = value;
        vertices[o + 3] = depth;
        v++;
      }
    }
    for (let s = 0; s < q; s++) {
      const p = start + s * 2; // inner, outer at this step; +2, +3 at the next
      index[k++] = p;
      index[k++] = p + 2;
      index[k++] = p + 1;
      index[k++] = p + 1;
      index[k++] = p + 2;
      index[k++] = p + 3;
    }
  }
  r.arcVertices = vertices.subarray(0, v * ARC_VERTEX_STRIDE).slice();
  r.arcIndex = index;
}
