/**
 * Text layer templates. Pure (no DOM, no Node), so it is unit-tested and shared.
 *
 *   {Column name}           the column's value at the current row
 *   {Column name|format}    formatted; formats can be chained: {Observation time UTC|month|upper}
 *   {{ and }}               literal braces
 *
 * Formats:
 *   date "2 Jan 1879", datetime "2 Jan 1879 08:30", time "08:30", year "1879",
 *   month "January" (time columns, in the dataset's timezone)
 *   numbers show the decimals the file uses ("12.30" stays "12.30"); fixed:N (N decimals)
 *   and int override that (number columns). Dates pad the day: "02 Jan 1879".
 *   upper (any column; applied to the formatted text)
 *
 * Dataset credits (the layer's dataset's `source`, `url` and `attribution` in project.json):
 *   {@source}  {@url}  {@attribution}   that field as typed (trimmed)
 *   {@credit}   one line from the non-empty parts: "Source: NIWA CliFlo · © NIWA, CC BY 4.0";
 *               with only one part, just that part ("Source: NIWA CliFlo" or "© NIWA, CC BY 4.0").
 *               The link is left out: put {@url} on its own line if it should show.
 *   Credits accept the upper format only. An empty field, or no dataset, renders as '' (not
 *   the missing-value dash). They are static: they never depend on the row.
 *   Unknown {@names} are looked up as columns, so a column whose name starts with "@" still
 *   works, except one named exactly "@source", "@url", "@attribution" or "@credit".
 *
 * Missing values render as an em dash, never "NaN" or 0. Mistakes stay visible: an unknown
 * column renders as {?Column name}, an unknown or unsuitable format as {Column name|?format}.
 * While the layer's dataset is still loading, column fields render as the dash.
 *
 * Cost: compileTemplate runs once per text change, bindTemplate once per text, dataset or
 * credits change, and renderTemplate only when the current row index changes.
 */

/** Structural view of a table column (matches src/data/columns.ts without importing it). */
export type TemplateColumn =
  | { name: string; type: 'number'; values: ArrayLike<number>; decimals?: number }
  | { name: string; type: 'time'; values: ArrayLike<number> }
  | { name: string; type: 'category'; codes: ArrayLike<number>; dictionary: readonly string[] }
  | { name: string; type: 'text'; values: ArrayLike<string | null> };

export interface TemplateTable {
  rowCount: number;
  columns: readonly TemplateColumn[];
}

export const MISSING_TEXT = '—';

/** A dataset's credits (structurally the Dataset entry of project.json; '' when unknown). */
export interface TemplateCredits {
  readonly source: string;
  readonly url: string;
  readonly attribution: string;
}

/** The credit placeholders, as typed in a template. */
export const CREDIT_TOKENS = ['{@source}', '{@url}', '{@attribution}', '{@credit}'] as const;

const CREDIT_SEPARATOR = ' · ';

/** The {@credit} line: "Source: <source> · <attribution>", empty parts (and their separator) left out. */
export function creditLine(credits: TemplateCredits | null): string {
  if (!credits) return '';
  const source = credits.source.trim();
  const attribution = credits.attribution.trim();
  const parts: string[] = [];
  if (source) parts.push(`Source: ${source}`);
  if (attribution) parts.push(attribution);
  return parts.join(CREDIT_SEPARATOR);
}

/** The text of a credit placeholder name (without the "@"), or null when it is not one. */
function creditText(name: string, credits: TemplateCredits | null): string | null {
  switch (name) {
    case 'source':
      return credits?.source.trim() ?? '';
    case 'url':
      return credits?.url.trim() ?? '';
    case 'attribution':
      return credits?.attribution.trim() ?? '';
    case 'credit':
      return creditLine(credits);
    default:
      return null;
  }
}

/** True when the credits show the same text (so a bound template need not change). */
export function sameCredits(a: TemplateCredits | null, b: TemplateCredits | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.source === b.source && a.url === b.url && a.attribution === b.attribution;
}

/** What bindTemplate resolves fields against besides the table. */
export interface BindOptions {
  /** The layer's dataset's credits; null (the default) when it has none. */
  credits?: TemplateCredits | null;
  /** The layer has a dataset whose table has not loaded yet: column fields show the dash. */
  loading?: boolean;
}

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'field'; column: string; formats: string[] };

export interface Template {
  parts: TemplatePart[];
}

/** Split a template into literal text and fields. Never throws; unmatched braces are literal. */
export function compileTemplate(src: string): Template {
  const parts: TemplatePart[] = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '{' && src[i + 1] === '{') {
      text += '{';
      i += 2;
    } else if (ch === '}' && src[i + 1] === '}') {
      text += '}';
      i += 2;
    } else if (ch === '{') {
      const close = src.indexOf('}', i + 1);
      const reopen = src.indexOf('{', i + 1);
      if (close < 0 || (reopen >= 0 && reopen < close)) {
        // No matching close before the next field: a literal brace.
        text += '{';
        i++;
        continue;
      }
      if (text) parts.push({ kind: 'text', text });
      text = '';
      const pieces = src.slice(i + 1, close).split('|');
      parts.push({
        kind: 'field',
        column: pieces[0]!.trim(),
        formats: pieces.slice(1).map((f) => f.trim()).filter((f) => f.length > 0),
      });
      i = close + 1;
    } else {
      text += ch;
      i++;
    }
  }
  if (text) parts.push({ kind: 'text', text });
  return { parts };
}

/** A bound piece: literal text, or a formatter for a row index. */
type Piece = string | ((row: number) => string);

export interface BoundTemplate {
  pieces: Piece[];
  /** True when the output depends on the row (some field resolved to a column). */
  dynamic: boolean;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
}

/** Local date parts in a timezone (invalid zones fall back to UTC, as in calendar.ts). */
function localParts(timeZone: string): (ms: number) => LocalParts {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  return (ms) => {
    const out: LocalParts = { year: 0, month: 1, day: 1, hour: 0, minute: 0 };
    for (const p of fmt.formatToParts(ms)) {
      if (p.type === 'year') out.year = Number(p.value);
      else if (p.type === 'month') out.month = Number(p.value);
      else if (p.type === 'day') out.day = Number(p.value);
      else if (p.type === 'hour') out.hour = Number(p.value) % 24;
      else if (p.type === 'minute') out.minute = Number(p.value);
    }
    return out;
  };
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Plain number formatting: float32 values shown to 7 significant digits ("12.3", not "12.300000190734863"). */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return MISSING_TEXT;
  const r = Number(v.toPrecision(7));
  return Object.is(r, -0) ? '0' : String(r);
}

const TIME_FORMATS = new Set(['date', 'datetime', 'time', 'year', 'month']);

type ValueFormatter = (row: number) => string | null;

/**
 * Formatter for one column and value format (null = default), or null when the format does
 * not suit the column. Returns null from the formatter for a missing value.
 */
function valueFormatter(col: TemplateColumn, format: string | null, timeZone: string): ValueFormatter | null {
  switch (col.type) {
    case 'time': {
      const f = format ?? 'datetime';
      if (!TIME_FORMATS.has(f)) return null;
      const parts = localParts(timeZone);
      const values = col.values;
      return (row) => {
        const ms = values[row];
        if (ms === undefined || Number.isNaN(ms)) return null;
        const p = parts(ms);
        const date = `${pad2(p.day)} ${MONTHS_SHORT[p.month - 1] ?? '?'} ${p.year}`;
        const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
        switch (f) {
          case 'date':
            return date;
          case 'time':
            return time;
          case 'year':
            return String(p.year);
          case 'month':
            return MONTHS[p.month - 1] ?? '?';
          default:
            return `${date} ${time}`;
        }
      };
    }
    case 'number': {
      const values = col.values;
      const read = (row: number): number | null => {
        const v = values[row];
        return v === undefined || Number.isNaN(v) ? null : v;
      };
      // As written in the file: the column's decimals (float32 values print exactly at that many).
      const decimals = col.decimals;
      if (format === null) return (row) => {
        const v = read(row);
        return v === null ? null : decimals !== undefined ? v.toFixed(decimals) : formatNumber(v);
      };
      if (format === 'int') return (row) => {
        const v = read(row);
        return v === null ? null : formatNumber(Math.round(v));
      };
      const fixed = /^fixed:(\d{1,2})$/.exec(format);
      if (fixed) {
        const digits = Math.min(20, Number(fixed[1]));
        return (row) => {
          const v = read(row);
          return v === null ? null : v.toFixed(digits);
        };
      }
      return null;
    }
    case 'category': {
      if (format !== null) return null;
      const { codes, dictionary } = col;
      return (row) => {
        const code = codes[row];
        return code === undefined || code < 0 ? null : (dictionary[code] ?? null);
      };
    }
    case 'text': {
      if (format !== null) return null;
      const values = col.values;
      return (row) => values[row] ?? null;
    }
  }
}

function fieldSource(column: string, formats: readonly string[]): string {
  return [column, ...formats].join('|');
}

function bindCredit(column: string, text: string, formats: readonly string[]): Piece {
  for (const raw of formats) if (raw.toLowerCase() !== 'upper') return `{${column}|?${raw}}`;
  return formats.length > 0 ? text.toUpperCase() : text;
}

function bindField(column: string, formats: readonly string[], table: TemplateTable | null, timeZone: string, options: BindOptions): Piece {
  if (column.startsWith('@')) {
    const credit = creditText(column.slice(1), options.credits ?? null);
    if (credit !== null) return bindCredit(column, credit, formats);
  }
  const col = table?.columns.find((c) => c.name === column);
  if (!col) return !table && options.loading ? MISSING_TEXT : `{?${fieldSource(column, formats)}}`;
  let valueFormat: string | null = null;
  let upper = false;
  for (const raw of formats) {
    const f = raw.toLowerCase();
    if (f === 'upper') {
      upper = true;
    } else if (valueFormat === null) {
      valueFormat = f;
    } else {
      return `{${column}|?${raw}}`; // a second value format
    }
  }
  const format = valueFormatter(col, valueFormat, timeZone);
  if (!format) return `{${column}|?${formats.find((f) => f.toLowerCase() === valueFormat) ?? valueFormat}}`;
  return (row) => {
    const s = format(row);
    if (s === null) return MISSING_TEXT;
    return upper ? s.toUpperCase() : s;
  };
}

/**
 * Resolve a template's columns against a table (null = no dataset: placeholders show as
 * {?name}, or as the dash while `options.loading`) and its credits against `options.credits`.
 */
export function bindTemplate(tpl: Template, table: TemplateTable | null, timeZone: string, options: BindOptions = {}): BoundTemplate {
  const pieces: Piece[] = [];
  let dynamic = false;
  for (const part of tpl.parts) {
    const piece = part.kind === 'text' ? part.text : bindField(part.column, part.formats, table, timeZone, options);
    if (typeof piece !== 'string') dynamic = true;
    // Merge adjacent literals so rendering does less work.
    const prev = pieces[pieces.length - 1];
    if (typeof piece === 'string' && typeof prev === 'string') pieces[pieces.length - 1] = prev + piece;
    else pieces.push(piece);
  }
  return { pieces, dynamic };
}

/** The text for row index `row`. */
export function renderTemplate(bound: BoundTemplate, row: number): string {
  let out = '';
  for (const p of bound.pieces) out += typeof p === 'string' ? p : p(row);
  return out;
}

/** Current row index for the layer's `row` fraction: round(row x (rowCount - 1)), clamped. */
export function templateRow(row: number, rowCount: number): number {
  if (rowCount <= 1 || !Number.isFinite(row)) return 0;
  const r = Math.min(Math.max(row, 0), 1);
  return Math.round(r * (rowCount - 1));
}
