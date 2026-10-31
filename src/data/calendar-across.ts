import type { InstancerLabels, InstancerLayer } from '../shared/layer-schema.ts';
import type { AxesLayout } from './instance-axes.ts';
import { MISSING_TEST } from './instance-data.ts';

/**
 * Labels across a calendar arrangement (InstancerLabelsSchema `across`): the year's divisions
 * along the day axis. Pure. Day of year d of year index y sits at origin + (d · cell x, −y · cell y),
 * as the vertex shader's `arrange()` places it, with each cell centred there; columns are the
 * days of a leap year (366), so 29 Feb is day 59.
 */

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** First day of year (0-based) of each month, in a leap year. */
export const MONTH_STARTS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335] as const;
const DAYS = 366;
const LINE_WIDTH = 2;
const LINE_OPACITY = 0.25;

/** A division of the year: columns [start, end) and its label. */
export interface Division {
  start: number;
  end: number;
  text: string;
}

type Across = InstancerLabels['across'];

/** Every division of the year for `unit`, in order (before `every` picks some). */
export function divisions(unit: Across['unit'], dayText: Across['dayText']): Division[] {
  const month = (m: number): Division => ({ start: MONTH_STARTS[m]!, end: m < 11 ? MONTH_STARTS[m + 1]! : DAYS, text: MONTH_NAMES[m]! });
  switch (unit) {
    case 'days':
      return Array.from({ length: DAYS }, (_, d) => {
        if (dayText === 'number') return { start: d, end: d + 1, text: String(d + 1) };
        let m = 11;
        while (MONTH_STARTS[m]! > d) m--;
        return { start: d, end: d + 1, text: `${String(d - MONTH_STARTS[m]! + 1).padStart(2, '0')} ${MONTH_NAMES[m]}` };
      });
    case 'weeks':
      // Week k starts on day 7k; the 53rd is the year's last one or two days.
      return Array.from({ length: 53 }, (_, k) => ({ start: 7 * k, end: Math.min(DAYS, 7 * k + 7), text: `W${k + 1}` }));
    case 'months':
      return MONTH_NAMES.map((_, m) => month(m));
    case 'quarters':
      return [0, 1, 2, 3].map((q) => ({ start: MONTH_STARTS[q * 3]!, end: q < 3 ? MONTH_STARTS[q * 3 + 3]! : DAYS, text: `Q${q + 1}` }));
    case 'seasons':
      // Southern hemisphere, by months; summer crosses the year, so it is labelled at both ends.
      return [
        { start: 0, end: MONTH_STARTS[2], text: 'Summer' },
        { start: MONTH_STARTS[2], end: MONTH_STARTS[5], text: 'Autumn' },
        { start: MONTH_STARTS[5], end: MONTH_STARTS[8], text: 'Winter' },
        { start: MONTH_STARTS[8], end: MONTH_STARTS[11], text: 'Spring' },
        { start: MONTH_STARTS[11], end: DAYS, text: 'Summer' },
      ];
  }
}

/** Smallest and largest year index among rows with a date, or null when none has one. */
export function yearIndexRange(yearIndex: Float32Array | null): [number, number] | null {
  if (!yearIndex) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < yearIndex.length; i++) {
    const y = yearIndex[i]!;
    if (!(y > MISSING_TEST)) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/**
 * Every `every`-th division (keys `<unit>:<index>`), each centred in its columns, and with lines
 * on, a line down the grid at the start of each labelled division but the first column, for a
 * calendar spanning year indices `years`. Empty unless the layer is a calendar with `across` on.
 */
export function layoutAcross(
  layer: Pick<InstancerLayer, 'arrangement' | 'origin' | 'cell'> & { labels: Pick<InstancerLabels, 'across' | 'offset' | 'size' | 'colour'> },
  years: readonly [number, number] | null,
): AxesLayout {
  const out: AxesLayout = { segments: [], texts: [] };
  const A = layer.labels.across;
  if (!A.enabled || layer.arrangement !== 'calendar' || !years) return out;
  const [ox, oy, oz] = layer.origin;
  const [cw, ch] = layer.cell;
  const top = oy - years[0] * ch + ch / 2;
  const bottom = oy - years[1] * ch - ch / 2;
  const gap = Math.abs(layer.labels.offset);
  const every = Math.max(1, Math.floor(A.every));
  const all = divisions(A.unit, A.dayText);
  for (let i = 0; i < all.length; i += every) {
    const d = all[i]!;
    out.texts.push({
      key: `${A.unit}:${i}`,
      text: d.text,
      x: ox + ((d.start + d.end - 1) / 2) * cw,
      y: A.side === 'top' ? top + gap : bottom - gap,
      z: oz,
      rotation: 0,
      anchorX: 'center',
      anchorY: A.side === 'top' ? 'bottom' : 'top',
      size: layer.labels.size,
      colour: layer.labels.colour,
    });
    if (A.lines && d.start > 0) {
      const x = ox + (d.start - 0.5) * cw;
      out.segments.push({ a: [x, top, oz], b: [x, bottom, oz], width: LINE_WIDTH, colour: layer.labels.colour, opacity: LINE_OPACITY });
    }
  }
  return out;
}
