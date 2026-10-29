import type { LineLayer } from '../shared/layer-schema.ts';
import type { Column, Table } from './columns.ts';
import { axisTicks, mapValue, tickDecimals, type AxesLayout, type AxisText, type Vec3 } from './instance-axes.ts';
import { resolveDomain } from './instance-data.ts';
import { columnText, MAX_LABELS, type DateLabels } from './instance-labels.ts';
import { linePositions, lineTStart, P_ROW, P_T, P_Y, POINT_STRIDE, rowRange, type LineData } from './line-data.ts';

/**
 * Chart furniture for a line layer (its `axes`, the instancer's InstancerAxesSchema). Pure: it
 * returns line segments and texts in the layer's own px space (y up), which the output draws as
 * children of the layer, so the transform applies.
 *
 * Points are placed by linePositions (the CPU twin of the line's vertex shader), so labels sit on
 * the drawn points, aggregated or not, and with a split on every series.
 *   values  the point's value at it (a bucket's combined value when aggregated)
 *   x axis  a baseline at the bottom of the y range, along the line, with a label per point
 *           (every `x.every` points): from `x.column`, else the time column's date, else the row
 *           number. Aggregated, a bucket is named by its period ("Mar 1990", "1990") or by its
 *           middle row. Labels thin themselves (a multiple of `every`) until they don't overlap,
 *           judged from the longest label and the spacing of the points
 *   y axis  ticks in the y column's units beside the line, optional gridlines
 * `span` 'full' lays the baseline, ticks and gridlines over every row the layer's animation
 * reaches (rows fractions from setRowsSpan); labels always follow the visible points.
 */

export interface LineSeriesInput {
  data: LineData;
  /** The table the series' rows index (a split series' own filtered table). */
  table: Table;
}

export interface LineAxesInput {
  layer: LineLayer;
  series: LineSeriesInput[];
  dates: DateLabels;
  timeZone: string;
  /** Rows fractions the layer's animation reaches ('full' span); omitted: the visible rows. */
  span?: readonly [number, number];
}

const TICK_LENGTH = 8;
const TICK_GAP = 6;
const AXIS_PAD = 12;
const CHAR_W = 0.55;

/** Label of bucket b (rows start..end-1) by its period, or null to name it by a row. */
function bucketPeriod(layer: LineLayer, table: Table, start: number, timeZone: string, formats: Map<string, Intl.DateTimeFormat>): string | null {
  const by = layer.aggregate.by;
  if ((by !== 'month' && by !== 'year') || layer.timeColumn === null) return null;
  const c = table.columns.find((col) => col.name === layer.timeColumn);
  if (c?.type !== 'time') return null;
  const ms = c.values[start]!;
  if (Number.isNaN(ms)) return null;
  let f = formats.get(by);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = by === 'year' ? { year: 'numeric' } : { month: 'short', year: 'numeric' };
    try {
      f = new Intl.DateTimeFormat('en-NZ', { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-NZ', { ...opts, timeZone: 'UTC' });
    }
    formats.set(by, f);
  }
  return f.format(ms);
}

export function layoutLineAxes(input: LineAxesInput): AxesLayout {
  const { layer, series, dates, timeZone } = input;
  const A = layer.axes;
  const out: AxesLayout = { segments: [], texts: [] };
  if (!A.values.enabled && !A.x.enabled && !A.y.enabled) return out;
  const drawn = series.filter((s) => s.data.count > 0 && s.data.y !== null);
  if (drawn.length === 0) return out;

  const yData = drawn[0]!.data.y!;
  const yDomain = resolveDomain(layer.y, yData);
  const [ox, oy, oz] = layer.origin;
  const [sx, sy, sz] = layer.step;
  const len = Math.hypot(sx, sy);
  const ux = len > 0 ? sx / len : 1;
  const uy = len > 0 ? sy / len : 0;
  const nx = -uy;
  const ny = ux;
  const yLo = mapValue(Math.min(yDomain[0], yDomain[1]), layer.y, yDomain);
  const yHi = mapValue(Math.max(yDomain[0], yDomain[1]), layer.y, yDomain);
  // The baseline: the bottom of the y range, through the line's origin.
  const base = Math.min(yLo, yHi);
  const line = (a: Vec3, b: Vec3, opacity = 1): void => {
    out.segments.push({ a, b, width: A.lineWidth, colour: A.colour, opacity });
  };

  // Placed points per series, and the visible / spanned point ranges.
  const placed = drawn.map((s) => {
    const pos = linePositions(s.data, layer);
    const [first, last] = rowRange(layer.rows, s.data.rowCount);
    const [sFirst, sLast] = input.span && A.span === 'full' ? rowRange(input.span, s.data.rowCount) : [first, last];
    return { s, pos, first: Math.min(first, sFirst), last: Math.max(last, sLast), vFirst: first, vLast: last };
  });

  // ---- value labels ------------------------------------------------------------------------
  if (A.values.enabled) {
    const V = A.values;
    const yCol = drawn[0]!.table.columns.find((c) => c.name === layer.y.column);
    const aggregated = layer.aggregate.by !== 'none';
    const decimals = V.decimals >= 0 ? V.decimals : yCol?.type === 'number' && yCol.decimals !== undefined ? yCol.decimals + (aggregated ? 1 : 0) : 2;
    placed.forEach(({ s, pos, vFirst, vLast }, si) => {
      const col = !aggregated && V.column !== null ? s.table.columns.find((c) => c.name === V.column) : undefined;
      const visible: number[] = [];
      for (let p = 0; p < s.data.count; p++) {
        const row = s.data.points[p * POINT_STRIDE + P_ROW]!;
        if (row >= vFirst && row <= vLast) visible.push(p);
      }
      const stride = Math.max(1, Math.ceil((visible.length * drawn.length) / MAX_LABELS));
      for (let q = 0; q < visible.length; q += stride) {
        const p = visible[q]!;
        const row = s.data.points[p * POINT_STRIDE + P_ROW]!;
        const text = col ? columnText(col, row, dates) : s.data.points[p * POINT_STRIDE + P_Y]!.toFixed(decimals);
        if (text === '') continue;
        const x = pos[p * 3]!;
        const y = pos[p * 3 + 1]!;
        const z = pos[p * 3 + 2]!;
        let ty = y + V.gap;
        let anchorY: AxisText['anchorY'] = 'bottom';
        if (V.place === 'base') ty = oy + base + V.gap;
        else if (V.place === 'inside-middle') {
          ty = y;
          anchorY = 'middle';
        } else if (V.place === 'inside-top') {
          ty = y - V.gap;
          anchorY = 'top';
        }
        out.texts.push({ key: `v:${si}:${row}`, text: `${V.prefix}${text}${V.suffix}`, x, y: ty, z, rotation: 0, anchorX: 'center', anchorY, size: V.size, colour: V.colour });
      }
    });
  }
  if (!A.x.enabled && !A.y.enabled) return out;

  // ---- extent along the line -----------------------------------------------------------------
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const { s, first, last } of placed) {
    for (let p = 0; p < s.data.count; p++) {
      const row = s.data.points[p * POINT_STRIDE + P_ROW]!;
      if (row < first || row > last) continue;
      const t = s.data.points[p * POINT_STRIDE + P_T]!;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!Number.isFinite(tMin)) return out;
  // The t that sits at the origin (followRange shifts the line by its first visible point), as linePositions.
  const tStart = lineTStart(placed[0]!.s.data, layer.followRange, placed[0]!.vFirst);
  const along = (t: number): Vec3 => [ox + (t - tStart) * sx, oy + base + (t - tStart) * sy, oz + (t - tStart) * sz];
  const half = layer.width / 2 + 4;
  const s0 = along(tMin);
  const s1 = along(tMax);
  const lineStart: Vec3 = [s0[0] - ux * half, s0[1] - uy * half, s0[2]];
  const lineEnd: Vec3 = [s1[0] + ux * half, s1[1] + uy * half, s1[2]];

  // ---- x axis --------------------------------------------------------------------------------
  if (A.x.enabled) {
    const X = A.x;
    if (X.line) line(lineStart, lineEnd);
    // Labels from the series with the most visible points (split series share their t).
    let best = placed[0]!;
    let bestCount = -1;
    for (const p of placed) {
      let n = 0;
      for (let k = 0; k < p.s.data.count; k++) {
        const row = p.s.data.points[k * POINT_STRIDE + P_ROW]!;
        if (row >= p.vFirst && row <= p.vLast) n++;
      }
      if (n > bestCount) {
        best = p;
        bestCount = n;
      }
    }
    const { s, vFirst, vLast } = best;
    const table = s.table;
    const col: Column | undefined = X.column === null ? undefined : table.columns.find((c) => c.name === X.column);
    const timeCol = col === undefined && X.column === null && layer.timeColumn !== null ? table.columns.find((c) => c.name === layer.timeColumn) : undefined;
    const starts = s.data.bucketStarts;
    const formats = new Map<string, Intl.DateTimeFormat>();
    const every = Math.max(1, Math.round(X.every));
    const angle = (X.angle * Math.PI) / 180;
    const rotation = Math.atan2(uy, ux) + angle;
    const anchorX: AxisText['anchorX'] = X.angle === 0 ? 'center' : X.angle > 0 ? 'right' : 'left';
    const anchorY: AxisText['anchorY'] = X.angle === 0 ? 'top' : 'middle';
    const textOf = (pt: number): string => {
      let text: string;
      if (starts) {
        const start = starts[pt]!;
        const end = starts[pt + 1]!;
        const mid = start + Math.floor((end - 1 - start) / 2);
        const period = col === undefined ? bucketPeriod(layer, table, start, timeZone, formats) : null;
        text = period ?? (col ? columnText(col, mid, dates) : timeCol ? columnText(timeCol, mid, dates) : `${start + 1}–${end}`);
      } else {
        text = col ? columnText(col, pt, dates) : timeCol ? columnText(timeCol, pt, dates) : String(pt + 1);
      }
      return text;
    };
    // Candidates every `every` visible points, then thinned so neighbours don't overlap.
    const candidates: { p: number; pt: number; text: string }[] = [];
    let k = 0;
    for (let p = 0; p < s.data.count; p++) {
      const pt = s.data.points[p * POINT_STRIDE + P_ROW]!;
      if (pt < vFirst || pt > vLast) continue;
      if (k++ % every !== 0) continue;
      candidates.push({ p, pt, text: textOf(pt) });
    }
    let longest = 0;
    for (const c of candidates) longest = Math.max(longest, c.text.length);
    let thin = Math.max(1, Math.ceil(candidates.length / MAX_LABELS));
    if (candidates.length > 1) {
      const tA = s.data.points[candidates[0]!.p * POINT_STRIDE + P_T]!;
      const tB = s.data.points[candidates[candidates.length - 1]!.p * POINT_STRIDE + P_T]!;
      const spacing = (Math.abs(tB - tA) * len) / (candidates.length - 1);
      // Along the axis a label takes its width (upright) or its height (turned 90°), plus a gap.
      const width = longest * CHAR_W * X.size * Math.abs(Math.cos(angle)) + X.size * Math.abs(Math.sin(angle)) + X.size * 0.6;
      if (spacing > 0) thin = Math.max(thin, Math.ceil(width / spacing));
    }
    for (let c = 0; c < candidates.length; c += thin) {
      const { p, pt, text } = candidates[c]!;
      if (text === '') continue;
      const q = along(s.data.points[p * POINT_STRIDE + P_T]!);
      out.texts.push({ key: `x:${pt}`, text, x: q[0] - nx * X.gap, y: q[1] - ny * X.gap, z: q[2], rotation, anchorX, anchorY, size: X.size, colour: X.colour });
    }
    if (X.title !== '') {
      const depth = X.angle === 0 ? X.size * 1.2 : longest * CHAR_W * X.size * Math.abs(Math.sin(angle)) + X.size * Math.abs(Math.cos(angle));
      const d = X.gap + depth + X.size * 0.6;
      const mx = (lineStart[0] + lineEnd[0]) / 2;
      const my = (lineStart[1] + lineEnd[1]) / 2;
      out.texts.push({ key: 'xt', text: X.title, x: mx - nx * d, y: my - ny * d, z: oz, rotation: Math.atan2(uy, ux), anchorX: 'center', anchorY: 'top', size: X.size, colour: X.colour });
    }
  }

  // ---- y axis --------------------------------------------------------------------------------
  if (A.y.enabled) {
    const Y = A.y;
    const left = Y.side === 'left';
    const sgn = left ? -1 : 1;
    const foot = left ? lineStart : lineEnd;
    const ax = foot[0] + sgn * ux * AXIS_PAD;
    const ay = foot[1] + sgn * uy * AXIS_PAD;
    // Height above the baseline: c is the mapped offset from the origin.
    const point = (c: number, dx = 0): Vec3 => [ax + sgn * ux * dx, ay + (c - base), foot[2]];
    if (Y.line) line(point(yLo), point(yHi));
    const ticks = axisTicks(yDomain, layer.y.scale, Y.ticks);
    const decimals = Y.decimals >= 0 ? Y.decimals : tickDecimals(ticks);
    let longest = 0;
    for (const v of ticks) {
      const c = mapValue(v, layer.y, yDomain);
      line(point(c), point(c, TICK_LENGTH));
      if (Y.grid) {
        const far = left ? lineEnd : lineStart;
        line(point(c), [far[0], far[1] + (c - base), far[2]], Y.gridOpacity);
      }
      const text = `${v.toFixed(decimals)}${Y.suffix}`;
      longest = Math.max(longest, text.length);
      const [px, py, pz] = point(c, TICK_LENGTH + TICK_GAP);
      out.texts.push({ key: `y:${text}`, text, x: px, y: py, z: pz, rotation: 0, anchorX: left ? 'right' : 'left', anchorY: 'middle', size: Y.size, colour: Y.colour });
    }
    if (Y.title !== '') {
      const d = TICK_LENGTH + TICK_GAP + longest * CHAR_W * Y.size + Y.size * 0.4;
      const [px, py, pz] = point((yLo + yHi) / 2, d);
      out.texts.push({ key: 'yt', text: Y.title, x: px, y: py, z: pz, rotation: left ? Math.PI / 2 : -Math.PI / 2, anchorX: 'center', anchorY: 'bottom', size: Y.size, colour: Y.colour });
    }
  }
  return out;
}
