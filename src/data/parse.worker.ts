/// <reference lib="webworker" />
/**
 * Fetches and parses a data file off the main thread. Columns come back as transferred
 * typed-array buffers, so the window receiving them pays no copy.
 */
import { tableTransferables } from './columns.ts';
import { detectCadence, type Cadence } from './gaps.ts';
import { parseText } from './parse.ts';
import type { WorkerRequest, WorkerResponse } from './dataset-loader.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, url, fileName } = ev.data;
  let response: WorkerResponse;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fileName}`);
    const text = await res.text();
    const t0 = performance.now();
    const result = parseText(text, fileName);
    const cadences: Record<string, Cadence> = {};
    for (const c of result.table.columns) {
      if (c.type === 'time' && !c.empty) cadences[c.name] = detectCadence(c.values);
    }
    response = { id, ok: true, result, cadences, bytes: text.length, parseMs: performance.now() - t0 };
    self.postMessage(response, tableTransferables(result.table));
    return;
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
