/**
 * Calendar fields for a time column, in a display timezone. Pure and worker-safe.
 * Used by the calendar arrangement (year rows x day-of-year columns).
 */

export interface CalendarFields {
  /** Local calendar year per row, NaN where the time is missing. */
  year: Float32Array;
  /** 0-based local day of year (0..365), NaN where the time is missing. */
  dayOfYear: Float32Array;
}

const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Local date of each timestamp in `timeZone`, via one Intl format per row. Runs in the parse
 * worker (about 0.2 s for 100k rows), never on the output's main thread. Invalid zones fall
 * back to UTC.
 */
export function calendarFields(values: Float64Array, timeZone: string): CalendarFields {
  const n = values.length;
  const year = new Float32Array(n);
  const dayOfYear = new Float32Array(n);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  for (let i = 0; i < n; i++) {
    const t = values[i]!;
    if (Number.isNaN(t)) {
      year[i] = NaN;
      dayOfYear[i] = NaN;
      continue;
    }
    // "YYYY-MM-DD" (en-CA). Years before 1000 are zero-padded by Intl, which parses fine.
    const s = fmt.format(t);
    const dash1 = s.indexOf('-', 1);
    const y = Number(s.slice(0, dash1));
    const m = Number(s.slice(dash1 + 1, dash1 + 3));
    const d = Number(s.slice(dash1 + 4, dash1 + 6));
    year[i] = y;
    dayOfYear[i] = (CUMULATIVE_DAYS[m - 1] ?? 0) + (m > 2 && isLeap(y) ? 1 : 0) + d - 1;
  }
  return { year, dayOfYear };
}
