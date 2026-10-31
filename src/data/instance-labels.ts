import type { InstancerLabels, InstancerLayer } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Column, Table } from './columns.ts';
import { MISSING_TEST } from './instance-data.ts';

/**
 * Labels at points of an instancer's arrangement (see InstancerLabelsSchema). Pure: which
 * rows get a label, what it says, and where it goes. The placement is the CPU twin of the
 * vertex shader's `arrange()` in client/output/layers/instancer.ts; change both together.
 */

/** Most labels drawn per layer (every label is laid out by troika). */
export const MAX_LABELS = 500;

/**
 * Rows that get a label, in row order: the earliest row (by t) of each calendar year or decade,
 * whatever order the file lists them in (rows with a missing time are skipped), or every
 * `rows`-th row with a defined t.
 */
export function labelRows(labels: Pick<InstancerLabels, 'every' | 'rows'>, t: Float32Array, calendar: CalendarFields | null): Int32Array {
  const out: number[] = [];
  if (labels.every === 'rows') {
    const step = Math.max(1, Math.floor(labels.rows));
    for (let i = 0; i < t.length; i += step) if (t[i]! > MISSING_TEST) out.push(i);
    return Int32Array.from(out);
  }
  if (!calendar) return new Int32Array(0);
  // Earliest row per year (or decade): a newest-first file would otherwise label each period at
  // its last day.
  const earliest = new Map<number, number>();
  for (let i = 0; i < t.length; i++) {
    const y = calendar.year[i]!;
    if (Number.isNaN(y) || !(t[i]! > MISSING_TEST)) continue;
    const key = labels.every === 'decade' ? Math.floor(y / 10) : y;
    const at = earliest.get(key);
    if (at === undefined || t[i]! < t[at]!) earliest.set(key, i);
  }
  for (const row of earliest.values()) out.push(row);
  return Int32Array.from(out.sort((a, b) => a - b));
}

/** Compact number text: whole numbers for big values, a few decimals for small ones. */
function formatNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1 || a === 0) return String(Number(v.toFixed(2)));
  return String(Number(v.toPrecision(2)));
}

/** Formats dates for labels in the dataset's timezone (one formatter per zone, made lazily). */
export class DateLabels {
  private format: Intl.DateTimeFormat | null = null;
  constructor(private timeZone: string) {}
  text(ms: number): string {
    // Day padded to two digits, so labels keep their width: "02 Jan 1879".
    this.format ??= new Intl.DateTimeFormat('en-NZ', { timeZone: this.timeZone, day: '2-digit', month: 'short', year: 'numeric' });
    return this.format.format(ms);
  }
}

/** A column's value at `row` as label text: numbers with the decimals the file writes, dates padded, missing as ''. */
export function columnText(c: Column, row: number, dates: DateLabels): string {
  switch (c.type) {
    case 'number': {
      const v = c.values[row]!;
      if (Number.isNaN(v)) return '';
      return c.decimals !== undefined ? v.toFixed(c.decimals) : formatNumber(v);
    }
    case 'time': {
      const v = c.values[row]!;
      return Number.isNaN(v) ? '' : dates.text(v);
    }
    case 'category': {
      const code = c.codes[row]!;
      return code < 0 ? '' : (c.dictionary[code] ?? '');
    }
    case 'text':
      return c.values[row] ?? '';
  }
}

/** The text of the label at `row` ('' when its value is missing). */
export function labelText(
  labels: Pick<InstancerLabels, 'every' | 'text' | 'column'>,
  row: number,
  table: Table,
  timeColumn: string | null,
  calendar: CalendarFields | null,
  dates: DateLabels,
): string {
  if (labels.every !== 'rows') {
    const y = calendar?.year[row];
    if (y === undefined || Number.isNaN(y)) return '';
    return labels.every === 'decade' ? `${Math.floor(y / 10) * 10}s` : String(y);
  }
  const name = labels.text === 'value' ? labels.column : timeColumn;
  const c = name ? table.columns.find((col) => col.name === name) : undefined;
  return c ? columnText(c, row, dates) : '';
}

export interface LabelPlacement {
  x: number;
  y: number;
  z: number;
  /** Radians, counter-clockwise (three's z rotation). */
  rotation: number;
  anchorX: 'left' | 'center' | 'right';
  anchorY: 'top' | 'middle' | 'bottom';
}

export function emptyPlacement(): LabelPlacement {
  return { x: 0, y: 0, z: 0, rotation: 0, anchorX: 'center', anchorY: 'middle' };
}

type Layout = Pick<
  InstancerLayer,
  'arrangement' | 'origin' | 'step' | 'gridColumns' | 'cell' | 'radius' | 'angleStep' | 'radiusStep'
> & { labels: Pick<InstancerLabels, 'offset' | 'orientation'> & Partial<Pick<InstancerLabels, 'align'>> };

/** Calendar columns (days of a leap year): a row's end, for labels pinned to it. */
const CALENDAR_DAYS = 366;

/** A rotation that keeps text readable: turned half round when it would read upside down. */
function readable(angle: number): { rotation: number; flipped: boolean } {
  const c = Math.cos(angle);
  return c < -1e-6 ? { rotation: angle + Math.PI, flipped: true } : { rotation: angle, flipped: false };
}

/**
 * Where the label of a row goes, written into `out`. `t` is the row's t minus tStart (as the
 * shader uses it); `yearIndex` / `dayOfYear` are its calendar cell (calendar arrangement).
 */
export function placeLabel(l: Layout, t: number, yearIndex: number, dayOfYear: number, out: LabelPlacement): LabelPlacement {
  const { offset, orientation } = l.labels;
  const [ox, oy, oz] = l.origin;
  out.z = oz;
  out.rotation = 0;
  out.anchorX = 'center';
  out.anchorY = 'middle';
  switch (l.arrangement) {
    case 'linear': {
      const x = ox + t * l.step[0];
      const y = oy + t * l.step[1];
      out.z = oz + t * l.step[2];
      // Offset "up" from the line: its left-hand normal, or straight up for a vertical or zero step.
      const len = Math.hypot(l.step[0], l.step[1]);
      const nx = len > 0 ? -l.step[1] / len : 0;
      const ny = len > 0 ? l.step[0] / len : 1;
      const r = readable(len > 0 ? Math.atan2(l.step[1], l.step[0]) : 0);
      const up = r.flipped ? -1 : 1;
      out.x = x + nx * offset * up;
      out.y = y + ny * offset * up;
      if (orientation === 'along') {
        out.rotation = r.rotation;
        out.anchorY = offset >= 0 ? 'bottom' : 'top';
      } else if (orientation === 'outward') {
        const o = readable(Math.atan2(ny * up, nx * up));
        out.rotation = o.rotation;
        out.anchorX = o.flipped ? 'right' : 'left';
      } else {
        out.anchorY = offset >= 0 ? 'bottom' : 'top';
      }
      return out;
    }
    case 'grid':
    case 'calendar': {
      const columns = l.arrangement === 'grid' ? Math.max(1, l.gridColumns) : CALENDAR_DAYS;
      const line = l.arrangement === 'grid' ? Math.floor(t / columns) : yearIndex;
      out.y = oy - line * l.cell[1];
      if (l.labels.align === 'end') {
        // Pinned past the row's last column; a positive offset moves it further right.
        out.x = ox + columns * l.cell[0] + offset;
        out.anchorX = offset >= 0 ? 'left' : 'right';
        return out;
      }
      // Left of the cell (or of the row's first column when pinned to its start).
      const col = l.labels.align === 'start' ? 0 : l.arrangement === 'grid' ? t - line * columns : dayOfYear;
      out.x = ox + col * l.cell[0] - offset;
      out.anchorX = offset >= 0 ? 'right' : 'left';
      return out;
    }
    case 'radial':
    case 'spiral': {
      // Clockwise from 12 o'clock, as in the shader.
      const a = (t * l.angleStep * Math.PI) / 180;
      const r = l.radius + (l.arrangement === 'spiral' ? t * l.radiusStep : 0);
      const sx = Math.sin(a);
      const cy = Math.cos(a);
      out.x = ox + sx * (r + offset);
      out.y = oy + cy * (r + offset);
      if (orientation === 'along') {
        // Tangent; the text's "up" points outward, or inward once flipped to stay readable.
        const tr = readable(-a);
        out.rotation = tr.rotation;
        out.anchorY = (offset >= 0) !== tr.flipped ? 'bottom' : 'top';
      } else if (orientation === 'outward') {
        const o = readable(Math.PI / 2 - a);
        out.rotation = o.rotation;
        out.anchorX = (offset >= 0) !== o.flipped ? 'left' : 'right';
      }
      return out;
    }
  }
}

/**
 * Which candidate labels to draw for the visible rows [first, last]: candidates `from..to`
 * (exclusive end) of `rows`, every `stride`-th of them so no more than MAX_LABELS show.
 * The stride depends on all candidates, not just the visible ones, so a label keeps its
 * slot (and text) as the row range moves.
 */
export function visibleLabels(rows: Int32Array, first: number, last: number): { from: number; to: number; stride: number } {
  const lower = (v: number) => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { from: lower(first), to: lower(last + 1), stride: Math.max(1, Math.ceil(rows.length / MAX_LABELS)) };
}
