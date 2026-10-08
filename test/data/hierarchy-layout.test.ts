import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { groupHierarchy, prepareHierarchyInputs, type HierarchyTree } from '../../src/data/hierarchy-data.ts';
import {
  ARC_VERTEX_STRIDE,
  arcQuads,
  CELL_STRIDE,
  layoutHierarchy,
  layoutShape,
  layoutTransferables,
  NODE_STRIDE,
  type HierarchyLayoutName,
  type LayoutParams,
} from '../../src/data/hierarchy-layout.ts';
import { MISSING } from '../../src/data/instance-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankHierarchyLayer, HIERARCHY_LAYOUTS, type HierarchyLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const DEFICIT = 'Deficit [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const calendars = { [TIME]: calendarFields(timeCol.values, 'Pacific/Auckland') };

function layer(patch: Partial<HierarchyLayer> = {}): HierarchyLayer {
  return {
    ...blankHierarchyLayer('h1', 'H', 'ds'),
    levels: [
      { kind: 'time', column: TIME, unit: 'decade' },
      { kind: 'time', column: TIME, unit: 'year' },
    ],
    valueColumn: RAIN,
    ...patch,
  };
}

function group(l: HierarchyLayer): HierarchyTree {
  return groupHierarchy(prepareHierarchyInputs(l, table, calendars)!, l.aggregate, 0, table.rowCount - 1);
}

const tree = group(layer());
const W = 1800;
const H = 960;

function params(layout: HierarchyLayoutName, patch: Partial<LayoutParams> = {}): LayoutParams {
  return { layout, width: W, height: H, innerRadius: 40, padding: 1, ...patch };
}

function leaves(t: HierarchyTree): number[] {
  const hasKids = new Uint8Array(t.nodeCount);
  for (let i = 1; i < t.nodeCount; i++) hasKids[t.parent[i]!] = 1;
  const out: number[] = [];
  for (let i = 0; i < t.nodeCount; i++) if (!hasKids[i]) out.push(i);
  return out;
}

describe('layoutHierarchy', () => {
  it('lays out every layout inside the box with finite numbers', () => {
    for (const name of HIERARCHY_LAYOUTS) {
      const r = layoutHierarchy(tree, params(name));
      expect(r.shape).toBe(layoutShape(name));
      expect(r.nodeCount).toBe(tree.nodeCount);
      for (let i = 0; i < r.nodeCount; i++) {
        expect(Number.isFinite(r.x[i]!)).toBe(true);
        expect(r.x[i]!).toBeGreaterThanOrEqual(-1e-3);
        expect(r.x[i]!).toBeLessThanOrEqual(W + 1e-3);
        expect(r.y[i]!).toBeGreaterThanOrEqual(-1e-3);
        expect(r.y[i]!).toBeLessThanOrEqual(H + 1e-3);
      }
      // Every buffer is distinct, so the result can be transferred.
      const buffers = layoutTransferables(r);
      expect(new Set(buffers).size).toBe(buffers.length);
    }
  });

  it('dendrogram: root on the left, leaves aligned on the right, elbow links', () => {
    const r = layoutHierarchy(tree, params('dendrogram'));
    expect(r.x[0]).toBe(0);
    for (const leaf of leaves(tree)) expect(r.x[leaf]).toBeCloseTo(W, 3);
    expect(r.links.length).toBe((tree.nodeCount - 1) * 2);
    // Every segment is horizontal or vertical (right-angled elbows).
    for (let s = 0; s < r.segments.length; s += 4) {
      const horizontal = Math.abs(r.segments[s + 1]! - r.segments[s + 3]!) < 1e-3;
      const vertical = Math.abs(r.segments[s]! - r.segments[s + 2]!) < 1e-3;
      expect(horizontal || vertical).toBe(true);
    }
    expect(r.nodes.length).toBe(tree.nodeCount * NODE_STRIDE);
    expect(r.nodes[2]).toBeCloseTo(tree.value[0]!, -1);
    expect(r.nodes[3]).toBe(0);
  });

  it('tree: depth runs left to right', () => {
    const r = layoutHierarchy(tree, params('tree'));
    for (let i = 1; i < tree.nodeCount; i++) expect(r.x[i]!).toBeGreaterThan(r.x[tree.parent[i]!]!);
  });

  it('radial dendrogram: centred, levels from the inner radius to the min half-size', () => {
    const r = layoutHierarchy(tree, params('radial-dendrogram'));
    expect(r.cx).toBe(W / 2);
    expect(r.cy).toBe(H / 2);
    expect(r.radius[0]).toBe(0);
    expect(r.visible[0]).toBe(0); // the centre stays clear
    for (let i = 1; i < tree.nodeCount; i++) {
      const rad = r.radius[i]!;
      expect(rad).toBeGreaterThanOrEqual(40 - 1e-3);
      expect(rad).toBeLessThanOrEqual(H / 2 + 1e-3);
      expect(Math.hypot(r.x[i]! - r.cx, r.y[i]! - r.cy)).toBeCloseTo(rad, 2);
      if (tree.depth[i] === 1) expect(rad).toBeCloseTo(40, 3);
      if (tree.depth[i] === 2) expect(rad).toBeCloseTo(H / 2, 3);
    }
    // Spokes are straight parent -> child lines; none from the (hidden) centre.
    for (let s = 0; s < r.segments.length; s += 4) {
      expect(Math.hypot(r.segments[s]! - r.cx, r.segments[s + 1]! - r.cy)).toBeGreaterThan(39);
    }
    // With no inner radius the root shows and level 1 sits one ring out.
    const open = layoutHierarchy(tree, params('radial-dendrogram', { innerRadius: 0 }));
    expect(open.visible[0]).toBe(1);
    const first = [...Array(tree.nodeCount).keys()].find((i) => tree.depth[i] === 1)!;
    expect(open.radius[first]).toBeCloseTo(H / 2 / 3, 3);
  });

  it('sunburst: arcs fill the turn per ring, sized by value', () => {
    const r = layoutHierarchy(tree, params('sunburst', { padding: 0 }));
    const R = H / 2;
    // The root is the full innermost ring; levels share the radius evenly.
    expect(r.bounds[0]).toBeCloseTo(0, 6);
    expect(r.bounds[1]).toBeCloseTo(2 * Math.PI, 5);
    expect(r.bounds[2]).toBeCloseTo(40, 3);
    expect(r.bounds[3]).toBeCloseTo(40 + (R - 40) / 3, 3);
    let span = 0;
    for (let i = 0; i < tree.nodeCount; i++) if (tree.depth[i] === 1) span += r.bounds[i * 4 + 1]! - r.bounds[i * 4]!;
    expect(span).toBeCloseTo(2 * Math.PI, 4);
    // A decade's angle is proportional to its rainfall.
    const d = [...Array(tree.nodeCount).keys()].find((i) => tree.depth[i] === 1 && tree.value[i]! > 0)!;
    expect((r.bounds[d * 4 + 1]! - r.bounds[d * 4]!) / (2 * Math.PI)).toBeCloseTo(tree.value[d]! / tree.value[0]!, 5);
    // Root label sits at the centre.
    expect(r.x[0]).toBeCloseTo(W / 2, 3);
    expect(r.y[0]).toBeCloseTo(H / 2, 3);
  });

  it('sunburst: tessellates a few quads per degree', () => {
    const r = layoutHierarchy(tree, params('sunburst'));
    let quads = 0;
    let arcs = 0;
    for (let i = 0; i < tree.nodeCount; i++) {
      if (!r.visible[i]) continue;
      arcs++;
      quads += arcQuads(r.bounds[i * 4 + 1]! - r.bounds[i * 4]!);
    }
    expect(arcQuads(2 * Math.PI)).toBe(360 * 3);
    expect(r.arcIndex.length).toBe(quads * 6);
    expect(r.arcVertices.length).toBe((quads + arcs) * 2 * ARC_VERTEX_STRIDE);
    for (let i = 0; i < r.arcIndex.length; i++) expect(r.arcIndex[i]!).toBeLessThan(r.arcVertices.length / ARC_VERTEX_STRIDE);
    // Padding insets every arc.
    expect(r.bounds[2]).toBeCloseTo(40.5, 3);
  });

  it('treemap: leaves tile the box by value, with padding', () => {
    const r = layoutHierarchy(tree, params('treemap', { padding: 0 }));
    let area = 0;
    for (const leaf of leaves(tree)) {
      const b = leaf * 4;
      area += (r.bounds[b + 2]! - r.bounds[b]!) * (r.bounds[b + 3]! - r.bounds[b + 1]!);
    }
    expect(area).toBeCloseTo(W * H, -2);
    const padded = layoutHierarchy(tree, params('treemap', { padding: 4 }));
    expect(padded.bounds[0]).toBe(0);
    const child = 1;
    expect(padded.bounds[child * 4]!).toBeGreaterThanOrEqual(4 - 1e-3);
    expect(padded.cells.length).toBe(tree.nodeCount * CELL_STRIDE);
  });

  it('icicle: root column on the left, children split its height', () => {
    const r = layoutHierarchy(tree, params('icicle', { padding: 0 }));
    expect(r.bounds[0]).toBe(0);
    expect(r.bounds[1]).toBe(0);
    expect(r.bounds[2]).toBeCloseTo(W / 3, 3);
    expect(r.bounds[3]).toBeCloseTo(H, 3);
  });

  it('pack: circles nest inside their parents', () => {
    const r = layoutHierarchy(tree, params('pack', { padding: 2 }));
    for (let i = 1; i < tree.nodeCount; i++) {
      if (!r.visible[i]) continue;
      const p = tree.parent[i]!;
      const dist = Math.hypot(r.x[i]! - r.x[p]!, r.y[i]! - r.y[p]!);
      expect(dist + r.radius[i]!).toBeLessThanOrEqual(r.radius[p]! + 1e-2);
    }
  });

  it('sizes areas by rows for a mean, and hides values that are missing', () => {
    const mean = group(layer({ aggregate: 'mean', valueColumn: DEFICIT }));
    expect(mean.sizeByValue).toBe(false);
    const r = layoutHierarchy(mean, params('treemap', { padding: 0 }));
    // The 1870s have no deficit values but do have rows, so they keep an area and a
    // missing value (the renderer shows it as missing, never as a number).
    const d = [...Array(mean.nodeCount).keys()].find((i) => mean.depth[i] === 1 && Number.isNaN(mean.value[i]!))!;
    expect(r.visible[d]).toBe(1);
    expect(r.cells[d * CELL_STRIDE + 4]).toBe(MISSING);
    // Summed missing values get no area.
    const sum = group(layer({ valueColumn: DEFICIT }));
    const rs = layoutHierarchy(sum, params('treemap', { padding: 0 }));
    const ds = [...Array(sum.nodeCount).keys()].find((i) => sum.depth[i] === 1 && Number.isNaN(sum.value[i]!))!;
    expect(rs.visible[ds]).toBe(0);
    expect(rs.cells[ds * CELL_STRIDE + 5]).toBe(-1);
  });

  it('copes with a single node and a degenerate box', () => {
    const single = groupHierarchy(prepareHierarchyInputs(layer(), table, calendars)!, 'sum', 5, 1);
    for (const name of HIERARCHY_LAYOUTS) {
      const r = layoutHierarchy(single, params(name, { width: 0, height: Number.NaN }));
      expect(r.nodeCount).toBe(1);
      expect(Number.isFinite(r.x[0]!)).toBe(true);
    }
  });
});
