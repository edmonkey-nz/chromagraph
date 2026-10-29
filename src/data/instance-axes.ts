import { scaleLinear, scaleLog } from 'd3-scale';
import type { InstancerLayer, Mapping } from '../shared/layer-schema.ts';
import type { Table } from './columns.ts';
import { MISSING_TEST, normalise, type InstanceData } from './instance-data.ts';
import { columnText, emptyPlacement, MAX_LABELS, placeLabel, type DateLabels, type LabelPlacement } from './instance-labels.ts';

/**
 * Chart furniture for an instancer (InstancerAxesSchema): value labels at the marks, and for a
 * linear arrangement a category axis along the marks and a value axis beside them. Pure: it
 * returns line segments and texts in the layer's own px space (y up), which the output draws
 * as children of the layer's mesh so the transform applies.
 *
 * Mark extents are the CPU twin of the instancer's vertex shader: the arranged point (via
 * placeLabel, itself the twin of `arrange()`), plus the x / y / z channel offsets, and a height of
 * the height channel (or size[1]) times the size channel. Bars and boxes grow from that point;
 * other primitives are centred on it. With heightAxis 'z' the height runs along z.
 *
 * With the x channel mapped (a scatter plot), the x axis is a value axis too: ticks in the x
 * column's units along the line, instead of a label per row ('xv:<tick text>' keys).
 */

export type Vec3 = [number, number, number];

export interface AxisSegment {
  a: Vec3;
  b: Vec3;
  /** px */
  width: number;
  colour: string;
  opacity: number;
}

export interface AxisText {
  /**
   * Stable identity across layouts ('v:<row>', 'x:<row>', 'y:<text>', 'xt', 'yt'): the output
   * keeps one text object per key, so a label is only laid out again when its own text changes.
   */
  key: string;
  text: string;
  x: number;
  y: number;
  z: number;
  /** Radians, counter-clockwise. */
  rotation: number;
  anchorX: LabelPlacement['anchorX'];
  anchorY: LabelPlacement['anchorY'];
  size: number;
  colour: string;
}

export interface AxesLayout {
  segments: AxisSegment[];
  texts: AxisText[];
}

type ScaledChannel = 'x' | 'y' | 'z' | 'height' | 'size';

export interface AxesInput {
  layer: InstancerLayer;
  data: Pick<InstanceData, 't' | 'yearIndex' | 'dayOfYear' | 'channels'>;
  table: Table;
  /** Resolved domains of the mapped channels (see resolveDomain). */
  domains: Partial<Record<ScaledChannel, readonly [number, number]>>;
  /** Visible rows [first, last], and the t the arrangement starts from (followRange). */
  first: number;
  last: number;
  /**
   * Rows [first, last] the axis lines, ticks, gridlines and titles span when `axes.span` is
   * 'full' (every row the layer's row animation reaches). Value and category labels always
   * follow the visible rows. Omitted: the visible rows.
   */
  span?: { first: number; last: number };
  tStart: number;
  dates: DateLabels;
}

/** px a tick mark sticks out from the value axis, and the gap before its label. */
const TICK_LENGTH = 8;
const TICK_GAP = 6;
/** px between the marks' outer edge and the value axis. */
const AXIS_PAD = 12;
/** Ticks a scatter plot's x value axis aims for. */
const X_TICKS = 8;
/** Rough width of a character as a share of the font size (for placing titles past labels). */
const CHAR_W = 0.55;

/** A mapped channel's value in px (the shader's mapChannel). */
export function mapValue(v: number, m: Pick<Mapping, 'scale' | 'steps' | 'clamp' | 'range'>, domain: readonly [number, number]): number {
  const n = normalise(v, [domain[0], domain[1]], m.scale, m.steps, m.clamp);
  return m.range[0] + (m.range[1] - m.range[0]) * n;
}

/** The channel a value axis and value labels describe: height for bars and boxes when mapped, else y. */
export function valueChannel(layer: InstancerLayer): 'height' | 'y' | null {
  const heightBars = layer.primitive === 'bar' || layer.primitive === 'box';
  if (heightBars && layer.channels.height.column !== null) return 'height';
  if (layer.channels.y.column !== null) return 'y';
  if (layer.channels.height.column !== null) return 'height';
  return null;
}

interface Mark {
  x: number;
  y: number;
  z: number;
  /** Coordinate along the height axis (y, or z with heightAxis 'z') of the mark's base and top. */
  base: number;
  top: number;
}

/** Round tick values over `domain` for `scale`, about `count` of them, inside the domain. */
export function axisTicks(domain: readonly [number, number], scale: Mapping['scale'], count: number): number[] {
  const lo = Math.min(domain[0], domain[1]);
  const hi = Math.max(domain[0], domain[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  const ticks = scale === 'log' && lo > 0 ? scaleLog().domain([lo, hi]).ticks(count) : scaleLinear().domain([lo, hi]).ticks(count);
  const eps = (hi - lo) * 1e-9;
  const inside = ticks.filter((t) => t >= lo - eps && t <= hi + eps);
  if (inside.length <= count * 2) return inside;
  // A log axis offers many minor ticks: keep the powers of ten when there are enough, else thin evenly.
  if (scale === 'log') {
    const decades = inside.filter((t) => Math.abs(Math.log10(t) - Math.round(Math.log10(t))) < 1e-9);
    if (decades.length >= 2 && decades.length <= count * 2) return decades;
  }
  const stride = Math.ceil(inside.length / count);
  return inside.filter((_, i) => i % stride === 0);
}

/** The fewest decimals (up to 10) that write every tick exactly: 0, 0.25, 0.5 needs 2. */
export function tickDecimals(ticks: readonly number[]): number {
  for (let d = 0; d < 10; d++) {
    const f = 10 ** d;
    if (ticks.every((t) => Math.abs(Math.round(t * f) / f - t) <= 1e-9 * Math.max(1, Math.abs(t)))) return d;
  }
  return 10;
}

/** Lays out the layer's axes and value labels (see the module comment). */
export function layoutAxes(input: AxesInput): AxesLayout {
  const { layer, data, table, domains, first, last, tStart, dates } = input;
  const full = layer.axes.span === 'full' && input.span !== undefined && input.span.last >= input.span.first;
  const lineFirst = full ? Math.min(first, input.span!.first) : first;
  const lineLast = full ? Math.max(last, input.span!.last) : last;
  const A = layer.axes;
  const out: AxesLayout = { segments: [], texts: [] };
  if ((!A.values.enabled && !A.x.enabled && !A.y.enabled) || lineLast < lineFirst) return out;

  const ch = layer.channels;
  const alongZ = layer.heightAxis === 'z';
  const baseAnchored = layer.primitive === 'bar' || layer.primitive === 'box';
  const placeAt = { ...layer, labels: { offset: 0, orientation: 'upright' as const } };
  const placement = emptyPlacement();
  const channelValue = (name: ScaledChannel, row: number): number | null => {
    const m = ch[name];
    const d = data.channels[name];
    const domain = domains[name];
    if (m.column === null || !d || !domain) return null;
    const v = d.values[row]!;
    return v < MISSING_TEST ? Number.NaN : mapValue(v, m, domain);
  };

  /** Where row `row`'s mark is, or null when it is not drawn (missing t or mapped value). */
  const markOf = (row: number): Mark | null => {
    const t = data.t[row]!;
    if (!(t > MISSING_TEST)) return null;
    placeLabel(placeAt, t - tStart, data.yearIndex?.[row] ?? 0, data.dayOfYear?.[row] ?? 0, placement);
    const xOff = channelValue('x', row);
    const yOff = channelValue('y', row);
    const zOff = channelValue('z', row);
    const height = channelValue('height', row);
    const mult = channelValue('size', row);
    if ([xOff, yOff, zOff, height, mult].some((v) => v !== null && Number.isNaN(v))) return null;
    const x = placement.x + (xOff ?? 0);
    const y = placement.y + (yOff ?? 0);
    const z = placement.z + (zOff ?? 0);
    const h = (height ?? layer.size[1]) * (mult ?? 1);
    const c = alongZ ? z : y;
    return baseAnchored ? { x, y, z, base: c, top: c + h } : { x, y, z, base: c - h / 2, top: c + h / 2 };
  };
  /** A point at height coordinate `c` above (x, y, z). */
  const at = (x: number, y: number, z: number, c: number): Vec3 => (alongZ ? [x, y, c] : [x, c, z]);

  // ---- value labels ------------------------------------------------------------------------
  if (A.values.enabled) {
    const V = A.values;
    const which = valueChannel(layer);
    const name = V.column ?? (which ? ch[which].column : null);
    const col = name === null ? undefined : table.columns.find((c) => c.name === name);
    if (col) {
      const visible = last - first + 1;
      const stride = Math.max(1, Math.ceil(visible / MAX_LABELS));
      for (let row = first; row <= last; row += stride) {
        const mark = markOf(row);
        if (!mark) continue;
        let text: string;
        if (V.decimals >= 0 && col.type === 'number') {
          const v = col.values[row]!;
          text = Number.isNaN(v) ? '' : v.toFixed(V.decimals);
        } else {
          text = columnText(col, row, dates);
        }
        if (text === '') continue;
        const up = mark.top >= mark.base ? 1 : -1;
        let c: number;
        let anchorY: AxisText['anchorY'];
        switch (V.place) {
          case 'above':
            c = mark.top + up * V.gap;
            anchorY = up > 0 ? 'bottom' : 'top';
            break;
          case 'inside-top':
            c = mark.top - up * V.gap;
            anchorY = up > 0 ? 'top' : 'bottom';
            break;
          case 'inside-middle':
            c = (mark.base + mark.top) / 2;
            anchorY = 'middle';
            break;
          case 'base':
            c = mark.base + up * V.gap;
            anchorY = up > 0 ? 'bottom' : 'top';
            break;
        }
        const [px, py, pz] = at(mark.x, mark.y, mark.z, c);
        out.texts.push({ key: `v:${row}`, text: `${V.prefix}${text}${V.suffix}`, x: px, y: py, z: pz, rotation: 0, anchorX: 'center', anchorY: alongZ ? 'middle' : anchorY, size: V.size, colour: V.colour });
      }
    }
  }

  if (layer.arrangement !== 'linear' || (!A.x.enabled && !A.y.enabled)) return out;

  // ---- the marks' extent along the line ------------------------------------------------------
  const sx = layer.step[0];
  const sy = layer.step[1];
  const len = Math.hypot(sx, sy);
  const ux = len > 0 ? sx / len : 1;
  const uy = len > 0 ? sy / len : 0;
  // "Up" from the line (its left-hand normal), and "down" for labels below it.
  const nx = -uy;
  const ny = ux;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let row = lineFirst; row <= lineLast; row++) {
    const t = data.t[row]!;
    if (!(t > MISSING_TEST)) continue;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!Number.isFinite(tMin)) return out;
  const [ox, oy, oz] = layer.origin;
  const along = (t: number): [number, number, number] => [ox + (t - tStart) * sx, oy + (t - tStart) * sy, oz + (t - tStart) * layer.step[2]];
  const half = Math.abs(layer.size[0]) / 2 + 4;
  const start = along(tMin);
  const end = along(tMax);
  // A mapped x widens the marks' extent by the x mapping's px span.
  const xDomain = ch.x.column !== null ? domains.x : undefined;
  const xEnds = xDomain ? [mapValue(xDomain[0], ch.x, xDomain), mapValue(xDomain[1], ch.x, xDomain)] : null;
  if (xEnds) {
    start[0] += Math.min(xEnds[0]!, xEnds[1]!);
    end[0] += Math.max(xEnds[0]!, xEnds[1]!);
  }
  const lineStart: Vec3 = [start[0] - ux * half, start[1] - uy * half, start[2]];
  const lineEnd: Vec3 = [end[0] + ux * half, end[1] + uy * half, end[2]];
  const line = (a: Vec3, b: Vec3, opacity = 1): void => {
    out.segments.push({ a, b, width: A.lineWidth, colour: A.colour, opacity });
  };

  // ---- category axis -------------------------------------------------------------------------
  if (A.x.enabled && xDomain) {
    // Value axis along x (scatter): ticks in the x column's units, below the line.
    const X = A.x;
    if (X.line) line(lineStart, lineEnd);
    const ticks = axisTicks(xDomain, ch.x.scale, X_TICKS);
    const decimals = tickDecimals(ticks);
    const base = along(tMin);
    const angle = (X.angle * Math.PI) / 180;
    const anchorX: AxisText['anchorX'] = X.angle === 0 ? 'center' : X.angle > 0 ? 'right' : 'left';
    for (const v of ticks) {
      const px = base[0] + mapValue(v, ch.x, xDomain);
      line([px, base[1], base[2]], [px, base[1] - TICK_LENGTH, base[2]]);
      const text = v.toFixed(decimals);
      out.texts.push({ key: `xv:${text}`, text, x: px, y: base[1] - TICK_LENGTH - X.gap, z: base[2], rotation: angle, anchorX, anchorY: X.angle === 0 ? 'top' : 'middle', size: X.size, colour: X.colour });
    }
    if (X.title !== '') {
      const d = TICK_LENGTH + X.gap + X.size * 1.8;
      out.texts.push({ key: 'xt', text: X.title, x: (lineStart[0] + lineEnd[0]) / 2, y: base[1] - d, z: base[2], rotation: 0, anchorX: 'center', anchorY: 'top', size: X.size, colour: X.colour });
    }
  } else if (A.x.enabled) {
    const X = A.x;
    if (X.line) line(lineStart, lineEnd);
    const col = X.column === null ? undefined : table.columns.find((c) => c.name === X.column);
    const timeCol = col === undefined && X.column === null && layer.timeColumn !== null ? table.columns.find((c) => c.name === layer.timeColumn) : undefined;
    const every = Math.max(1, Math.round(X.every));
    const count = Math.floor(last / every) - Math.floor((first - 1) / every);
    const stride = every * Math.max(1, Math.ceil(count / MAX_LABELS));
    const angle = (X.angle * Math.PI) / 180;
    const rotation = Math.atan2(uy, ux) + angle;
    const anchorX: AxisText['anchorX'] = X.angle === 0 ? 'center' : X.angle > 0 ? 'right' : 'left';
    const anchorY: AxisText['anchorY'] = X.angle === 0 ? 'top' : 'middle';
    let longest = 0;
    for (let row = Math.ceil(first / stride) * stride; row <= last; row += stride) {
      const t = data.t[row]!;
      if (!(t > MISSING_TEST)) continue;
      const text = col ? columnText(col, row, dates) : timeCol ? columnText(timeCol, row, dates) : String(row + 1);
      if (text === '') continue;
      longest = Math.max(longest, text.length);
      const p = along(t);
      out.texts.push({ key: `x:${row}`, text, x: p[0] - nx * X.gap, y: p[1] - ny * X.gap, z: p[2], rotation, anchorX, anchorY, size: X.size, colour: X.colour });
    }
    if (X.title !== '') {
      const depth = X.angle === 0 ? X.size * 1.2 : longest * CHAR_W * X.size * Math.abs(Math.sin(angle)) + X.size * Math.abs(Math.cos(angle));
      const d = X.gap + depth + X.size * 0.6;
      const mx = (lineStart[0] + lineEnd[0]) / 2;
      const my = (lineStart[1] + lineEnd[1]) / 2;
      out.texts.push({ key: 'xt', text: X.title, x: mx - nx * d, y: my - ny * d, z: oz, rotation: Math.atan2(uy, ux), anchorX: 'center', anchorY: 'top', size: X.size, colour: X.colour });
    }
  }

  // ---- value axis ----------------------------------------------------------------------------
  const which = valueChannel(layer);
  const domain = which ? domains[which] : undefined;
  if (A.y.enabled && which && domain) {
    const Y = A.y;
    const m = ch[which];
    // Height starts at the line (origin); the y channel offsets from it too.
    const base = alongZ && which === 'height' ? oz : oy;
    const zAxis = alongZ && which === 'height';
    const left = Y.side === 'left';
    const s = left ? -1 : 1;
    const foot = left ? lineStart : lineEnd;
    const ax = foot[0] + s * ux * AXIS_PAD;
    const ay = foot[1] + s * uy * AXIS_PAD;
    const point = (c: number, dx = 0): Vec3 => (zAxis ? [ax + s * ux * dx, ay + s * uy * dx, c] : [ax + s * ux * dx, c + (ay - oy), oz]);
    const c0 = base + mapValue(Math.min(domain[0], domain[1]), m, domain);
    const c1 = base + mapValue(Math.max(domain[0], domain[1]), m, domain);
    if (Y.line) line(point(c0), point(c1));
    const ticks = axisTicks(domain, m.scale, Y.ticks);
    const decimals = Y.decimals >= 0 ? Y.decimals : tickDecimals(ticks);
    let longest = 0;
    for (const v of ticks) {
      const c = base + mapValue(v, m, domain);
      line(point(c), point(c, TICK_LENGTH));
      if (Y.grid) {
        // Across the marks, from the axis to the far end of the line.
        const far = left ? lineEnd : lineStart;
        const g: Vec3 = zAxis ? [far[0], far[1], c] : [far[0], c + (far[1] - oy), oz];
        line(point(c), g, Y.gridOpacity);
      }
      const text = `${v.toFixed(decimals)}${Y.suffix}`;
      longest = Math.max(longest, text.length);
      const [px, py, pz] = point(c, TICK_LENGTH + TICK_GAP);
      out.texts.push({ key: `y:${text}`, text, x: px, y: py, z: pz, rotation: 0, anchorX: left ? 'right' : 'left', anchorY: 'middle', size: Y.size, colour: Y.colour });
    }
    if (Y.title !== '') {
      const d = TICK_LENGTH + TICK_GAP + longest * CHAR_W * Y.size + Y.size * 0.4;
      const [px, py, pz] = point((c0 + c1) / 2, d);
      out.texts.push({ key: 'yt', text: Y.title, x: px, y: py, z: pz, rotation: left ? Math.PI / 2 : -Math.PI / 2, anchorX: 'center', anchorY: 'bottom', size: Y.size, colour: Y.colour });
    }
  }
  return out;
}
