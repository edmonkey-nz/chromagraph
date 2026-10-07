/**
 * CSV / JSON text -> column Table. Pure and synchronous; intended to run in a web worker
 * (never on the output window's main thread). Nothing here throws for bad input: problems
 * become ParseIssues and, at worst, an empty table.
 *
 * Row numbers in issue messages are 1-based data rows (header excluded). The `row` field
 * of a ParseIssue, where set, is 0-based as documented in columns.ts.
 */

import Papa from 'papaparse';
import type { Column, ParseIssue, ParseResult } from './columns.ts';
import { inferColumn, isMissing } from './infer.ts';

const MAX_PAPA_ISSUES = 20;
const MAX_ROW_EXAMPLES = 5;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(message: string, issues: ParseIssue[] = []): ParseResult {
  return {
    table: { rowCount: 0, columns: [] },
    report: { rowCount: 0, columnCount: 0, raggedRows: 0, issues: [...issues, { severity: 'error', message }] },
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function listRows(rows: number[], total: number): string {
  const shown = rows.map((r) => r + 1).join(', ');
  return total > rows.length ? `${shown}, …` : shown;
}

/**
 * Give blank names a generated `column N` (N = 1-based source position) and make duplicate
 * names unique with a ` (2)`, ` (3)` … suffix. Each change is reported.
 */
function resolveNames(raw: string[], issues: ParseIssue[], blankReason: (i: number) => string): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let name = raw[i] ?? '';
    if (isMissing(name)) {
      name = `column ${i + 1}`;
      issues.push({ severity: 'warning', column: name, message: `${blankReason(i)}; named it "${name}".` });
    }
    if (used.has(name)) {
      let k = 2;
      while (used.has(`${name} (${k})`)) k++;
      const renamed = `${name} (${k})`;
      issues.push({
        severity: 'warning',
        column: renamed,
        message: `Duplicate column name "${name}" (column ${i + 1}); renamed to "${renamed}".`,
      });
      name = renamed;
    }
    used.add(name);
    out.push(name);
  }
  return out;
}

function buildResult(names: string[], raws: (string | undefined)[][], rowCount: number, issues: ParseIssue[], raggedRows: number): ParseResult {
  const columns: Column[] = [];
  for (let j = 0; j < names.length; j++) {
    const { column, issues: colIssues } = inferColumn(names[j]!, j, raws[j]!);
    columns.push(column);
    for (const iss of colIssues) issues.push(iss);
  }
  return {
    table: { rowCount, columns },
    report: { rowCount, columnCount: columns.length, raggedRows, issues },
  };
}

// ---------------------------------------------------------------------------------------
// CSV

export function parseCsv(text: string): ParseResult {
  try {
    return parseCsvInner(text);
  } catch (err) {
    return failure(`CSV could not be parsed: ${errorMessage(err)}`);
  }
}

function parseCsvInner(input: string): ParseResult {
  const text = stripBom(typeof input === 'string' ? input : '');
  if (text.trim().length === 0) return failure('The file is empty.');

  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy', dynamicTyping: false });
  const rows = parsed.data;
  const issues: ParseIssue[] = [];

  const header = rows[0];
  if (header === undefined) return failure('No header row found.');
  const rowCount = rows.length - 1;

  // Papa errors. With header:false, Papa's row index includes the header row.
  let papaCount = 0;
  for (const e of parsed.errors) {
    // Papa falls back to ',' when it cannot guess, which is what a CSV should use anyway.
    if (e.code === 'UndetectableDelimiter') continue;
    papaCount++;
    if (papaCount > MAX_PAPA_ISSUES) continue;
    const dataRow = typeof e.row === 'number' ? e.row - 1 : undefined;
    const issue: ParseIssue = {
      severity: e.type === 'Quotes' ? 'error' : 'warning',
      message: `CSV: ${e.message}${dataRow !== undefined && dataRow >= 0 ? ` (row ${dataRow + 1})` : ''}`,
    };
    if (dataRow !== undefined && dataRow >= 0) issue.row = dataRow;
    issues.push(issue);
  }
  // Delimiter is auto-detected (so TSV and ';' files work); make a non-comma guess visible.
  const delimiter = parsed.meta.delimiter;
  if (delimiter !== ',' && delimiter !== undefined) {
    issues.push({ severity: 'warning', message: `CSV: fields are separated by ${JSON.stringify(delimiter)}, not commas.` });
  }
  if (papaCount > MAX_PAPA_ISSUES) {
    issues.push({ severity: 'warning', message: `CSV: ${papaCount - MAX_PAPA_ISSUES} further parser problems not listed.` });
  }

  // Trailing blank header names (trailing commas): drop those columns only if every value in
  // them is missing too. Otherwise keep them (named `column N` below).
  const headerLen = header.length;
  let keep = headerLen;
  while (keep > 0 && isMissing(header[keep - 1])) keep--;
  const blankTail = keep;
  if (keep < headerLen) {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]!;
      const last = Math.min(row.length, headerLen) - 1;
      for (let j = last; j >= keep; j--) {
        if (!isMissing(row[j])) {
          keep = j + 1;
          break;
        }
      }
      if (keep === headerLen) break;
    }
  }
  // Dropping all-empty trailing columns loses nothing, so it is not reported.

  const names = resolveNames(header.slice(0, keep), issues, (i) =>
    i >= blankTail
      ? `Column ${i + 1} has no header name (trailing comma) but contains values`
      : `Column ${i + 1} has no header name`,
  );
  const width = names.length;

  // Columns, filled row-major. Short rows leave undefined (missing); extra fields are dropped.
  const raws: (string | undefined)[][] = [];
  for (let j = 0; j < width; j++) raws.push([]);
  let ragged = 0;
  let short = 0;
  let long = 0;
  let lostValues = 0;
  const raggedExamples: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r + 1]!;
    const len = row.length;
    // Rows that only lack the dropped all-empty trailing columns are not ragged.
    if (len < width || len > headerLen) {
      ragged++;
      if (raggedExamples.length < MAX_ROW_EXAMPLES) raggedExamples.push(r);
      if (len < width) short++;
      else {
        long++;
        for (let j = headerLen; j < len; j++) {
          if (!isMissing(row[j])) {
            lostValues++;
            break;
          }
        }
      }
    }
    for (let j = 0; j < width; j++) raws[j]!.push(row[j]);
  }
  if (ragged > 0) {
    const parts: string[] = [];
    if (short > 0) parts.push(`${short} with too few fields (missing fields read as missing values)`);
    if (long > 0) {
      parts.push(
        `${long} with too many fields (extra fields dropped` +
          (lostValues > 0 ? `; ${lostValues} of these rows had non-empty extra values)` : `; all were empty)`),
      );
    }
    issues.push({
      severity: 'warning',
      message:
        `${ragged} rows have a different number of fields from the header (${headerLen}): ` +
        `${parts.join(', ')}. First rows: ${listRows(raggedExamples, ragged)}.`,
    });
  }

  return buildResult(names, raws, rowCount, issues, ragged);
}

// ---------------------------------------------------------------------------------------
// JSON

/** Classifies a JSON value: undefined = missing, string = value, NESTED = object/array. */
const NESTED = Symbol('nested');

function jsonCell(v: unknown): string | undefined | typeof NESTED {
  if (v === null || v === undefined) return undefined;
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return String(v); // round-trips exactly
    case 'boolean':
      return v ? 'true' : 'false';
    case 'object':
      return NESTED;
    default:
      return String(v);
  }
}

/** Convert one JSON value, stringifying nested objects/arrays and counting them. */
function toCell(v: unknown, nestedCounts: number[], j: number): string | undefined {
  const c = jsonCell(v);
  if (c !== NESTED) return c;
  nestedCounts[j] = (nestedCounts[j] ?? 0) + 1;
  return JSON.stringify(v);
}

function reportNested(names: string[], nestedCounts: number[], issues: ParseIssue[]): void {
  for (let j = 0; j < names.length; j++) {
    const c = nestedCounts[j] ?? 0;
    if (c > 0) {
      issues.push({
        severity: 'warning',
        column: names[j]!,
        message: `Column "${names[j]}" has ${c} nested objects/arrays; they were kept as JSON text.`,
      });
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseJson(text: string): ParseResult {
  try {
    return parseJsonInner(text);
  } catch (err) {
    return failure(`JSON could not be parsed: ${errorMessage(err)}`);
  }
}

function parseJsonInner(input: string): ParseResult {
  const text = stripBom(typeof input === 'string' ? input : '');
  if (text.trim().length === 0) return failure('The file is empty.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return failure(`Invalid JSON: ${errorMessage(err)}`);
  }
  if (Array.isArray(data)) return fromRecords(data);
  if (isRecord(data)) return fromColumns(data);
  return failure('JSON must be an array of records or an object of column arrays.');
}

function fromRecords(data: unknown[]): ParseResult {
  const issues: ParseIssue[] = [];
  const rowCount = data.length;

  // Union of keys, first-seen order.
  const keyIndex = new Map<string, number>();
  const keys: string[] = [];
  let notObjects = 0;
  const notObjectRows: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    const rec = data[r];
    if (!isRecord(rec)) {
      notObjects++;
      if (notObjectRows.length < MAX_ROW_EXAMPLES) notObjectRows.push(r);
      continue;
    }
    for (const k in rec) {
      if (!Object.hasOwn(rec, k)) continue;
      if (!keyIndex.has(k)) {
        keyIndex.set(k, keys.length);
        keys.push(k);
      }
    }
  }
  if (notObjects > 0) {
    issues.push({
      severity: 'error',
      message:
        `${notObjects} array entries are not records (objects); their rows are all missing values. ` +
        `First rows: ${listRows(notObjectRows, notObjects)}.`,
    });
  }

  const width = keys.length;
  const raws: (string | undefined)[][] = [];
  for (let j = 0; j < width; j++) raws.push([]);
  const nestedCounts: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    const rec = data[r];
    const ok = isRecord(rec);
    for (let j = 0; j < width; j++) {
      const k = keys[j]!;
      raws[j]!.push(ok && Object.hasOwn(rec, k) ? toCell(rec[k], nestedCounts, j) : undefined);
    }
  }

  const names = resolveNames(keys, issues, (i) => `Field ${i + 1} has an empty key`);
  reportNested(names, nestedCounts, issues);
  return buildResult(names, raws, rowCount, issues, 0);
}

function fromColumns(data: Record<string, unknown>): ParseResult {
  const issues: ParseIssue[] = [];
  const keys: string[] = [];
  const arrays: unknown[][] = [];
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (Array.isArray(v)) {
      keys.push(k);
      arrays.push(v);
    } else {
      issues.push({
        severity: 'error',
        column: k,
        message: `"${k}" is not an array, so it was left out (expected an object of equal-length column arrays).`,
      });
    }
  }
  if (keys.length === 0) {
    return failure('JSON object has no column arrays (expected an object of equal-length column arrays).', issues);
  }

  let rowCount = 0;
  for (const a of arrays) if (a.length > rowCount) rowCount = a.length;

  const names = resolveNames(keys, issues, (i) => `Column ${i + 1} has an empty key`);
  const shortCols: string[] = [];
  for (let j = 0; j < names.length; j++) {
    const len = arrays[j]!.length;
    if (len < rowCount) shortCols.push(`"${names[j]}" (${len})`);
  }
  if (shortCols.length > 0) {
    issues.push({
      severity: 'error',
      message:
        `Column arrays have unequal lengths. Padded to ${rowCount} rows with missing values: ` +
        `${shortCols.join(', ')}.`,
    });
  }

  const raws: (string | undefined)[][] = [];
  const nestedCounts: number[] = [];
  for (let j = 0; j < arrays.length; j++) {
    const src = arrays[j]!;
    const out: (string | undefined)[] = [];
    for (let r = 0; r < rowCount; r++) out.push(r < src.length ? toCell(src[r], nestedCounts, j) : undefined);
    raws.push(out);
  }
  reportNested(names, nestedCounts, issues);
  return buildResult(names, raws, rowCount, issues, 0);
}

// ---------------------------------------------------------------------------------------

/** Parse by file extension: `.json` as JSON, anything else as CSV. */
export function parseText(text: string, fileName: string): ParseResult {
  try {
    return /\.json$/i.test(String(fileName)) ? parseJson(text) : parseCsv(text);
  } catch (err) {
    return failure(`File could not be parsed: ${errorMessage(err)}`);
  }
}
