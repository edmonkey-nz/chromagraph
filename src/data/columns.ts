/**
 * Column-oriented in-memory tables. Shared contract between the parser (worker), the
 * windows that receive parsed data, and the renderer.
 *
 * Missing values are never filled in:
 *   number / time -> NaN
 *   category      -> code -1
 *   text          -> null
 *
 * Precision: time columns are epoch-ms in a Float64Array. Do NOT upload them to the GPU
 * as raw epoch-ms float32 — for 19th-century data the float32 step is ~4 minutes. Upload
 * offsets from the column's own `min` (in days or seconds) instead.
 */

export type ColumnType = 'number' | 'time' | 'category' | 'text';

interface ColumnBase {
  /** Header name as it appears in the file (BOM stripped, otherwise untouched). */
  name: string;
  /** Position of the column in the source file. */
  index: number;
  length: number;
  nullCount: number;
  /** True when every value in the column is missing. Such columns are typed `number`. */
  empty: boolean;
  /** Minimum non-missing value (number/time only, otherwise NaN). Computed in float64. */
  min: number;
  /** Maximum non-missing value (number/time only, otherwise NaN). Computed in float64. */
  max: number;
}

export interface NumberColumn extends ColumnBase {
  type: 'number';
  values: Float32Array;
  /**
   * Most digits after the decimal point among the column's values as written in the file
   * ("12.30" counts 2; exponent forms are ignored), capped at 10. Text shows numbers with
   * this many decimals, so "12.30" never displays as "12.3" (see text-template.ts).
   * Undefined for columns not made by the parser.
   */
  decimals?: number;
}

export interface TimeColumn extends ColumnBase {
  type: 'time';
  /** UTC epoch milliseconds. */
  values: Float64Array;
  /** True when some values had no offset/zone and were read as UTC (reported as a warning). */
  assumedUtc: boolean;
}

export interface CategoryColumn extends ColumnBase {
  type: 'category';
  /** Index into `dictionary`, or -1 when missing. */
  codes: Int32Array;
  /** Distinct values in first-seen order. */
  dictionary: string[];
}

export interface TextColumn extends ColumnBase {
  type: 'text';
  values: (string | null)[];
}

export type Column = NumberColumn | TimeColumn | CategoryColumn | TextColumn;

export interface Table {
  rowCount: number;
  columns: Column[];
}

export type IssueSeverity = 'warning' | 'error';

export interface ParseIssue {
  severity: IssueSeverity;
  message: string;
  /** 0-based data row (excluding header) when the issue is row-specific. */
  row?: number;
  column?: string;
  /**
   * A mostly-numeric column read as text: the texts that kept it from being numbers (a few,
   * distinct), which the control window offers as "treat as missing" markers.
   */
  markers?: string[];
}

export interface ParseReport {
  rowCount: number;
  columnCount: number;
  /** Rows whose field count differed from the header. */
  raggedRows: number;
  issues: ParseIssue[];
}

export interface ParseResult {
  table: Table;
  report: ParseReport;
}

export function getColumn(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => c.name === name);
}

/** ArrayBuffers that can be transferred (not copied) when posting a table between threads. */
export function tableTransferables(table: Table): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const c of table.columns) {
    if (c.type === 'number' || c.type === 'time') out.push(c.values.buffer as ArrayBuffer);
    else if (c.type === 'category') out.push(c.codes.buffer as ArrayBuffer);
  }
  return out;
}
