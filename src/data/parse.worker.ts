/// <reference lib="webworker" />
/**
 * Fetches and parses a data file off the main thread. Columns come back as transferred
 * typed-array buffers, so the window receiving them pays no copy.
 */
import { calendarFields, type CalendarFields } from './calendar.ts';
import { tableTransferables } from './columns.ts';
import { detectCadence, type Cadence } from './gaps.ts';
import { parseText } from './parse.ts';
import type { WorkerRequest, WorkerResponse } from './dataset-loader.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, url, fileName, timeZone, missing } = ev.data;
  let response: WorkerResponse;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fileName}`);
    const text = await res.text();
    const t0 = performance.now();
    const result = parseText(text, fileName, { missing: missing ?? [] });
    const cadences: Record<string, Cadence> = {};
    const calendars: Record<string, CalendarFields> = {};
    const transfer = tableTransferables(result.table);
    for (const c of result.table.columns) {
      if (c.type !== 'time' || c.empty) continue;
      cadences[c.name] = detectCadence(c.values);
      if (timeZone) {
        const cal = calendarFields(c.values, timeZone);
        calendars[c.name] = cal;
        transfer.push(cal.year.buffer as ArrayBuffer, cal.dayOfYear.buffer as ArrayBuffer);
      }
    }
    response = { id, ok: true, result, cadences, calendars, bytes: text.length, parseMs: performance.now() - t0 };
    self.postMessage(response, transfer);
    return;
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
