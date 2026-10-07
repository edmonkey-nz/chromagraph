import type { ParseResult } from './columns.ts';
import type { CalendarFields } from './calendar.ts';
import type { Cadence } from './gaps.ts';
import parseWorkerUrl from './parse.worker.ts?worker&url';

export interface WorkerRequest {
  id: number;
  url: string;
  fileName: string;
  /** When set, calendar fields are derived for every time column in this zone. */
  timeZone?: string;
}

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      result: ParseResult;
      cadences: Record<string, Cadence>;
      calendars: Record<string, CalendarFields>;
      bytes: number;
      parseMs: number;
    }
  | { id: number; ok: false; error: string };

export interface LoadedFile {
  result: ParseResult;
  /** Cadence of each non-empty time column, by column name. */
  cadences: Record<string, Cadence>;
  /** Calendar fields per time column (only when a timeZone was requested). */
  calendars: Record<string, CalendarFields>;
  bytes: number;
  parseMs: number;
}

const TIMEOUT_MS = 60_000;

/** Built worker script URL (exported so the output can ask its service worker to cache it). */
export const PARSE_WORKER_URL: string = parseWorkerUrl;

interface Pending {
  resolve(v: LoadedFile): void;
  reject(e: Error): void;
  timer: number;
}

/**
 * Main-thread handle on the parse worker. Requests are queued in the worker; a crashed or
 * hung worker is replaced and its pending requests fail (they never hang the caller).
 */
export class DatasetLoader {
  private worker: Promise<Worker> | null = null;
  private live: Worker | null = null;
  private blobUrl: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  load(url: string, fileName: string, timeZone?: string): Promise<LoadedFile> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.failAll(new Error(`parsing ${fileName} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ensureWorker()
        // Absolute: a worker started from a blob URL has no usable base for relative URLs.
        .then((w) =>
          w.postMessage({
            id,
            url: new URL(url, location.href).href,
            fileName,
            ...(timeZone ? { timeZone } : {}),
          } satisfies WorkerRequest),
        )
        .catch((err: unknown) => this.settle(id, null, err instanceof Error ? err : new Error(String(err))));
    });
  }

  private ensureWorker(): Promise<Worker> {
    if (!this.worker) {
      const created = this.createWorker();
      this.worker = created;
      // A failed start must not stick: the next load tries again.
      created.catch(() => {
        if (this.worker === created) this.worker = null;
      });
    }
    return this.worker;
  }

  private async createWorker(): Promise<Worker> {
    let src = PARSE_WORKER_URL;
    if (import.meta.env.PROD) {
      // Chrome does not route a dedicated worker's script load through the page's service
      // worker, so an output reloaded while the server is down could not start the parser.
      // Fetching the script (which the service worker can serve from cache) and starting it
      // from a blob URL avoids that. The built worker is one self-contained module.
      const res = await fetch(PARSE_WORKER_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading the parse worker`);
      this.blobUrl = URL.createObjectURL(await res.blob());
      src = this.blobUrl;
    }
    const w = new Worker(src, { type: 'module', name: 'parse' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.ok) {
        const { result, cadences, calendars, bytes, parseMs } = m;
        this.settle(m.id, { result, cadences, calendars, bytes, parseMs }, null);
      } else {
        this.settle(m.id, null, new Error(m.error));
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      this.failAll(new Error(`parse worker crashed: ${ev.message || 'unknown error'}`));
    };
    this.live = w;
    return w;
  }

  private settle(id: number, value: LoadedFile | null, error: Error | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve(value!);
  }

  /** Fail everything in flight and replace the worker. */
  private failAll(error: Error): void {
    this.live?.terminate();
    this.live = null;
    this.worker = null;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    for (const id of [...this.pending.keys()]) this.settle(id, null, error);
  }

  dispose(): void {
    this.failAll(new Error('loader disposed'));
  }
}

export function dataUrl(projectName: string, file: string): string {
  return `/projects/${encodeURIComponent(projectName)}/data/${encodeURIComponent(file)}`;
}
