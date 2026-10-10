import type { Column } from './columns.ts';

/**
 * Pure helpers for the Datasets tab's row viewer (client/control/table-viewer.ts): how each
 * cell reads, the order rows sort into, and a starting width per column. Values are shown as
 * parsed, never altered: missing stays missing (null here), numbers keep the decimals the file
 * writes, times show in the dataset's timezone.
 */

export type SortDir = 'asc' | 'desc';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "02 Jan 1879 08:30" in `timeZone` (UTC when the zone is unknown). */
function timeFormatter(timeZone: string): (ms: number) => string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  return (ms) => {
    let y = 0;
    let mo = 1;
    let d = 1;
    let hh = 0;
    let mm = 0;
    for (const p of fmt.formatToParts(ms)) {
      if (p.type === 'year') y = Number(p.value);
      else if (p.type === 'month') mo = Number(p.value);
      else if (p.type === 'day') d = Number(p.value);
      else if (p.type === 'hour') hh = Number(p.value) % 24;
      else if (p.type === 'minute') mm = Number(p.value);
    }
    return `${pad2(d)} ${MONTHS[mo - 1] ?? '?'} ${y} ${pad2(hh)}:${pad2(mm)}`;
  };
}

/** Text of one cell: the value as the viewer shows it, or null when it is missing. */
export function cellFormatter(c: Column, timeZone: string): (row: number) => string | null {
  switch (c.type) {
    case 'number': {
      const values = c.values;
      const decimals = c.decimals;
      return (row) => {
        const v = values[row];
        if (v === undefined || Number.isNaN(v)) return null;
        // Float32 values to 7 significant digits when the file's decimals are unknown.
        if (decimals === undefined) return String(Number(v.toPrecision(7)));
        return v.toFixed(decimals);
      };
    }
    case 'time': {
      const values = c.values;
      const format = timeFormatter(timeZone);
      return (row) => {
        const v = values[row];
        return v === undefined || Number.isNaN(v) ? null : format(v);
      };
    }
    case 'category': {
      const { codes, dictionary } = c;
      return (row) => {
        const code = codes[row];
        return code === undefined || code < 0 ? null : (dictionary[code] ?? null);
      };
    }
    case 'text': {
      const values = c.values;
      return (row) => values[row] ?? null;
    }
  }
}

/**
 * Row indices sorted by column `c`, ascending or descending. Missing values always come last
 * and ties keep file order, so a sort is stable and repeatable.
 */
export function sortRows(c: Column, rowCount: number, dir: SortDir): Uint32Array {
  const n = Math.min(rowCount, c.length);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const sign = dir === 'asc' ? 1 : -1;
  // A numeric key per row (NaN = missing): values, or the rank of each distinct string.
  let key: ArrayLike<number>;
  if (c.type === 'number' || c.type === 'time') {
    key = c.values;
  } else if (c.type === 'category') {
    const byText = c.dictionary.map((s, code) => ({ s, code })).sort((a, b) => compareText(a.s, b.s));
    const rank = new Float64Array(c.dictionary.length);
    byText.forEach((e, r) => (rank[e.code] = r));
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const code = c.codes[i]!;
      k[i] = code < 0 ? Number.NaN : rank[code]!;
    }
    key = k;
  } else {
    const distinct = [...new Set(c.values.filter((v): v is string => v !== null))].sort(compareText);
    const rank = new Map(distinct.map((s, r) => [s, r]));
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = c.values[i];
      k[i] = v === null || v === undefined ? Number.NaN : rank.get(v)!;
    }
    key = k;
  }
  order.sort((a, b) => {
    const ka = key[a]!;
    const kb = key[b]!;
    const ma = Number.isNaN(ka);
    const mb = Number.isNaN(kb);
    if (ma || mb) return ma === mb ? a - b : ma ? 1 : -1;
    return ka === kb ? a - b : (ka - kb) * sign;
  });
  return order;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareText(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A starting width (in characters) for a column: its header or its longest value among a
 * sample of rows, whichever is wider, between 6 and 40.
 */
export function columnChars(c: Column, rowCount: number, format: (row: number) => string | null, sample = 200): number {
  let w = c.name.length + 2; // room for the sort arrow
  const n = Math.min(rowCount, c.length);
  const step = Math.max(1, Math.floor(n / sample));
  for (let i = 0; i < n; i += step) w = Math.max(w, format(i)?.length ?? 0);
  return Math.min(Math.max(w, 6), 40);
}
