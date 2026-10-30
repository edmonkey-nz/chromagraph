/**
 * Column type inference. Pure functions: no DOM, no Node APIs (runs in a web worker).
 *
 * Rules (see CLAUDE.md, "Data is never silently altered"):
 *   - Missing means undefined, empty or whitespace-only. Nothing else ("NA", "null", "-"
 *     are ordinary values). Values are never coerced into another type.
 *   - Checks run in order: empty, number, time, category, text.
 *   - A column that is *mostly* numeric or *mostly* ISO time but has stray values keeps its
 *     non-numeric type and gets a warning that names the offending values.
 *
 * Row numbers in issue messages are 1-based data rows (header excluded). The `row` field
 * of a ParseIssue, where set, is 0-based as documented in columns.ts.
 */

import type { Column, ParseIssue } from './columns.ts';

/** Optional sign, digits with optional fraction or a leading-dot fraction, optional exponent. */
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const MAX_CATEGORIES = 256;
const MOSTLY = 0.9;
const MAX_EXAMPLES = 3;
const FLOAT32_MAX = 3.4028234663852886e38;

/** Whitespace as understood by String.prototype.trim (fast path for printable ASCII). */
function isWs(c: number): boolean {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** True for undefined, empty or whitespace-only values. */
export function isMissing(v: string | undefined | null): v is undefined | null | '' {
  if (v === undefined || v === null || v.length === 0) return true;
  if (!isWs(v.charCodeAt(0))) return false;
  return v.trim().length === 0;
}

/** Trimmed value, or null when missing. Avoids allocating when there is nothing to trim. */
function clean(v: string | undefined): string | null {
  if (v === undefined || v.length === 0) return null;
  if (!isWs(v.charCodeAt(0)) && !isWs(v.charCodeAt(v.length - 1))) return v;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : (MONTH_DAYS[m - 1] ?? 0);
}

/** Set by parseIsoTime: whether the last successfully parsed value carried a zone. */
let lastHadZone = false;

/** Two ASCII digits at `i` as a number, or -1. */
function d2(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : -1;
}

/**
 * Parse a strict ISO-8601 date/time to UTC epoch ms, or NaN. Accepted forms:
 *
 *   YYYY-MM-DD
 *   YYYY-MM-DD[T| ]hh:mm[:ss[.s|.ss|.sss]][Z|±hh:mm|±hhmm]
 *
 * A zone is only accepted after a time. Field ranges and real calendar days are checked
 * (proleptic Gregorian). Values without a zone are read as UTC; `lastHadZone` tells the
 * caller so it can report it. Scans character codes rather than using a regex so the hot
 * path allocates nothing. Exported for tests.
 */
export function parseIsoTime(s: string): number {
  const len = s.length;
  if (len < 10 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return NaN;
  const yHi = d2(s, 0);
  const yLo = d2(s, 2);
  const mo = d2(s, 5);
  const d = d2(s, 8);
  if (yHi < 0 || yLo < 0 || mo < 1 || mo > 12 || d < 1) return NaN;
  const y = yHi * 100 + yLo;
  if (d > daysInMonth(y, mo)) return NaN;

  let h = 0;
  let mi = 0;
  let sec = 0;
  let ms = 0;
  let offsetMin = 0;
  let hasZone = false;
  if (len > 10) {
    const sep = s.charCodeAt(10);
    if ((sep !== 84 /* T */ && sep !== 32) || len < 16 || s.charCodeAt(13) !== 58 /* : */) return NaN;
    h = d2(s, 11);
    mi = d2(s, 14);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return NaN;
    let p = 16;
    if (p < len && s.charCodeAt(p) === 58) {
      sec = d2(s, p + 1);
      if (sec < 0 || sec > 59) return NaN;
      p += 3;
      if (p < len && s.charCodeAt(p) === 46 /* . */) {
        p++;
        let digits = 0;
        let scale = 100;
        for (; p < len; p++) {
          const c = s.charCodeAt(p) - 48;
          if (c < 0 || c > 9) break;
          if (++digits > 3) return NaN;
          ms += c * scale;
          scale /= 10;
        }
        if (digits === 0) return NaN;
      }
    }
    if (p < len) {
      const z = s.charCodeAt(p);
      if (z === 90 /* Z */ && p + 1 === len) {
        hasZone = true;
      } else if (z === 43 /* + */ || z === 45 /* - */) {
        const oh = d2(s, p + 1);
        let om: number;
        if (s.charCodeAt(p + 3) === 58) {
          om = d2(s, p + 4);
          p += 6;
        } else {
          om = d2(s, p + 3);
          p += 5;
        }
        if (p !== len || oh < 0 || oh > 23 || om < 0 || om > 59) return NaN;
        offsetMin = (z === 45 ? -1 : 1) * (oh * 60 + om);
        hasZone = true;
      } else {
        return NaN;
      }
    }
  }

  let t: number;
  if (y >= 100) {
    t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  } else {
    // Date.UTC maps years 0-99 to 1900-1999, so set the full year explicitly.
    const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, sec, ms));
    dt.setUTCFullYear(y, mo - 1, d);
    t = dt.getTime();
  }
  lastHadZone = hasZone;
  return t - offsetMin * 60_000;
}

interface Example {
  value: string;
  row: number;
}

function describeExamples(examples: Example[]): string {
  return examples.map((e) => `${JSON.stringify(e.value)} at row ${e.row + 1}`).join(', ');
}

function mostlyWarning(
  name: string,
  kind: 'numeric' | 'ISO time',
  bad: number,
  nonMissing: number,
  examples: Example[],
  finalType: string,
): ParseIssue {
  const noun = kind === 'numeric' ? 'numbers' : 'ISO-8601 times';
  const issue: ParseIssue = {
    severity: 'warning',
    column: name,
    message:
      `Column "${name}" is mostly ${kind} but ${bad} of ${nonMissing} values are not ${noun} ` +
      `(e.g. ${describeExamples(examples)}), so it was read as ${finalType}. No values were converted.`,
  };
  if (examples[0]) issue.row = examples[0].row;
  if (kind === 'numeric') issue.markers = [...new Set(examples.map((e) => e.value.trim()))].filter((v) => v.length > 0 && v.length <= 40);
  return issue;
}

/** Infer the type of one column from its raw string values. Never throws. */
export function inferColumn(
  name: string,
  index: number,
  raw: (string | undefined)[],
): { column: Column; issues: ParseIssue[] } {
  try {
    return inferColumnInner(name, index, raw);
  } catch (err) {
    const n = Array.isArray(raw) ? raw.length : 0;
    return {
      column: {
        type: 'text', name, index, length: n, nullCount: n, empty: true, min: NaN, max: NaN,
        values: new Array<string | null>(n).fill(null),
      },
      issues: [{
        severity: 'error',
        column: name,
        message: `Column "${name}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}

function inferColumnInner(
  name: string,
  index: number,
  raw: (string | undefined)[],
): { column: Column; issues: ParseIssue[] } {
  const n = raw.length;
  const issues: ParseIssue[] = [];

  // Pass 1: missing values and numbers.
  const nums = new Float32Array(n);
  let nullCount = 0;
  let numBad = 0;
  let overflow = 0;
  let min = Infinity;
  let max = -Infinity;
  let decimals = 0;
  const numExamples: Example[] = [];
  for (let i = 0; i < n; i++) {
    const s = clean(raw[i]);
    if (s === null) {
      nullCount++;
      nums[i] = NaN;
      continue;
    }
    if (NUMBER_RE.test(s)) {
      const x = Number(s);
      // Finite check rejects exponents that overflow float64 (e.g. "1e400").
      if (Number.isFinite(x)) {
        nums[i] = x;
        const dot = s.indexOf('.');
        if (dot >= 0 && !/[eE]/.test(s)) decimals = Math.max(decimals, Math.min(s.length - dot - 1, 10));
        if (x < min) min = x;
        if (x > max) max = x;
        if (Math.abs(x) > FLOAT32_MAX) overflow++;
        continue;
      }
    }
    numBad++;
    if (numExamples.length < MAX_EXAMPLES) numExamples.push({ value: s, row: i });
  }
  const nonMissing = n - nullCount;
  const base = { name, index, length: n, nullCount };

  if (nonMissing === 0) {
    nums.fill(NaN);
    return { column: { ...base, type: 'number', empty: true, min: NaN, max: NaN, values: nums }, issues };
  }

  if (numBad === 0) {
    if (overflow > 0) {
      issues.push({
        severity: 'warning',
        column: name,
        message:
          `Column "${name}" has ${overflow} values beyond the float32 range; they are stored as ` +
          `±Infinity (min/max keep the exact values).`,
      });
    }
    return { column: { ...base, type: 'number', empty: false, min, max, values: nums, decimals }, issues };
  }

  const mostlyNumeric = (nonMissing - numBad) / nonMissing >= MOSTLY;

  // Pass 2: ISO times. Bail out once it can be neither time nor mostly time.
  const maxTimeBad = Math.floor(nonMissing * (1 - MOSTLY) + 1e-9);
  const times = new Float64Array(n);
  let timeBad = 0;
  let noZone = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  const timeExamples: Example[] = [];
  for (let i = 0; i < n; i++) {
    const s = clean(raw[i]);
    if (s === null) {
      times[i] = NaN;
      continue;
    }
    const t = parseIsoTime(s);
    if (Number.isNaN(t)) {
      timeBad++;
      if (timeExamples.length < MAX_EXAMPLES) timeExamples.push({ value: s, row: i });
      if (timeBad > maxTimeBad) break;
      continue;
    }
    times[i] = t;
    if (!lastHadZone) noZone++;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }

  if (timeBad === 0) {
    if (noZone > 0) {
      issues.push({
        severity: 'warning',
        column: name,
        message:
          `Column "${name}": ${noZone} of ${nonMissing} times have no time zone and were read as UTC.`,
      });
    }
    return {
      column: { ...base, type: 'time', empty: false, min: tMin, max: tMax, values: times, assumedUtc: noZone > 0 },
      issues,
    };
  }
  const mostlyTime = timeBad <= maxTimeBad;

  // Pass 3: category. Values compared as-is (no trimming or case folding).
  const limit = Math.min(MAX_CATEGORIES, Math.floor(nonMissing * 0.5));
  const codes = new Int32Array(n);
  const lookup = new Map<string, number>();
  const dictionary: string[] = [];
  let isCategory = true;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (isMissing(v)) {
      codes[i] = -1;
      continue;
    }
    let code = lookup.get(v);
    if (code === undefined) {
      code = dictionary.length;
      if (code >= limit) {
        isCategory = false;
        break;
      }
      lookup.set(v, code);
      dictionary.push(v);
    }
    codes[i] = code;
  }

  const finalType = isCategory ? 'category' : 'text';
  if (mostlyNumeric) issues.push(mostlyWarning(name, 'numeric', numBad, nonMissing, numExamples, finalType));
  if (mostlyTime) issues.push(mostlyWarning(name, 'ISO time', timeBad, nonMissing, timeExamples, finalType));

  if (isCategory) {
    return { column: { ...base, type: 'category', empty: false, min: NaN, max: NaN, codes, dictionary }, issues };
  }

  // Pass 4: text, verbatim.
  const values: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    values.push(isMissing(v) ? null : v);
  }
  return { column: { ...base, type: 'text', empty: false, min: NaN, max: NaN, values }, issues };
}
