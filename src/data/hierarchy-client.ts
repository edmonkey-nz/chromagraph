/**
 * Main-thread handle on the hierarchy worker, which groups rows into trees and lays them
 * out (d3-hierarchy) off the output's main thread.
 *
 * The worker caches each layer's inputs (by `inputKey`) and grouped trees (by `groupKey`),
 * so a change of row range regroups without resending columns, and a layout-only change
 * (layout, size, inner radius, padding) only lays the cached tree out again. Inputs are
 * copied before posting: the main thread keeps its table.
 *
 * Like DatasetLoader: requests settle with a Promise, a hung job times out, and a crashed
 * or hung worker is replaced (its pending jobs fail; they never hang the caller).
 */
import type { Aggregate, GroupInputs, HierarchyTree } from './hierarchy-data.ts';
import { copyInputs } from './hierarchy-data.ts';
import type { HierarchyLayoutResult, LayoutParams } from './hierarchy-layout.ts';
import hierarchyWorkerUrl from './hierarchy.worker.ts?worker&url';

export interface HierarchyRunRequest {
  t: 'run';
  id: number;
  inputKey: string;
  /** Present when the worker may not have this inputKey's inputs yet. */
  inputs?: GroupInputs;
  groupKey: string;
  aggregate: Aggregate;
  first: number;
  last: number;
  /** Send the tree back (the caller has no copy for this groupKey yet). */
  wantTree: boolean;
  layout: LayoutParams;
}

export interface HierarchyDropRequest {
  t: 'drop';
  inputKey: string;
}

export type HierarchyRequest = HierarchyRunRequest | HierarchyDropRequest;

export type HierarchyResponse =
  | { id: number; ok: true; tree: HierarchyTree | null; layout: HierarchyLayoutResult; groupMs: number; layoutMs: number }
  | { id: number; ok: false; error: string; needInputs?: boolean };

export interface HierarchyJob {
  inputKey: string;
  /** The table's own arrays; copied only when the worker needs them. */
  inputs: () => GroupInputs;
  groupKey: string;
  aggregate: Aggregate;
  first: number;
  last: number;
  wantTree: boolean;
  layout: LayoutParams;
}

export interface HierarchyJobResult {
  tree: HierarchyTree | null;
  layout: HierarchyLayoutResult;
  groupMs: number;
  layoutMs: number;
}

const TIMEOUT_MS = 30_000;

/** Built worker script URL. */
export const HIERARCHY_WORKER_URL: string = hierarchyWorkerUrl;

interface Pending {
  resolve(v: HierarchyResponse): void;
  reject(e: Error): void;
  timer: number;
}

export class HierarchyClient {
  private worker: Promise<Worker> | null = null;
  private live: Worker | null = null;
  private blobUrl: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** inputKeys whose inputs the current worker has been sent. */
  private sent = new Set<string>();

  async run(job: HierarchyJob): Promise<HierarchyJobResult> {
    let res = await this.post(job, !this.sent.has(job.inputKey));
    if (!res.ok && res.needInputs) {
      // The worker evicted (or never had) this layer's inputs: send them once more.
      res = await this.post(job, true);
    }
    if (!res.ok) throw new Error(res.error);
    return { tree: res.tree, layout: res.layout, groupMs: res.groupMs, layoutMs: res.layoutMs };
  }

  /** Let the worker forget a layer's inputs and trees (the layer was rebuilt or removed). */
  drop(inputKey: string): void {
    if (!this.sent.delete(inputKey) || !this.live) return;
    try {
      this.live.postMessage({ t: 'drop', inputKey } satisfies HierarchyDropRequest);
    } catch {
      // best effort
    }
  }

  dispose(): void {
    this.failAll(new Error('hierarchy client disposed'));
  }

  private post(job: HierarchyJob, withInputs: boolean): Promise<HierarchyResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.failAll(new Error('hierarchy layout timed out'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ensureWorker()
        .then((w) => {
          const msg: HierarchyRunRequest = {
            t: 'run',
            id,
            inputKey: job.inputKey,
            groupKey: job.groupKey,
            aggregate: job.aggregate,
            first: job.first,
            last: job.last,
            wantTree: job.wantTree,
            layout: job.layout,
          };
          if (withInputs) {
            const copy = copyInputs(job.inputs());
            msg.inputs = copy.inputs;
            this.sent.add(job.inputKey);
            w.postMessage(msg, copy.transfer);
          } else {
            w.postMessage(msg);
          }
        })
        .catch((err: unknown) => this.settle(id, null, err instanceof Error ? err : new Error(String(err))));
    });
  }

  private ensureWorker(): Promise<Worker> {
    if (!this.worker) {
      const created = this.createWorker();
      this.worker = created;
      // A failed start must not stick: the next job tries again.
      created.catch(() => {
        if (this.worker === created) this.worker = null;
      });
    }
    return this.worker;
  }

  private async createWorker(): Promise<Worker> {
    let src = HIERARCHY_WORKER_URL;
    if (import.meta.env.PROD) {
      // As for the parse worker: start from a blob URL so an output reloaded while the
      // server is down can still start it from the service worker's cache, and ask the
      // service worker to keep the script (the page's own precache list predates it).
      const url = new URL(HIERARCHY_WORKER_URL, location.href).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading the hierarchy worker`);
      this.blobUrl = URL.createObjectURL(await res.blob());
      src = this.blobUrl;
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ t: 'precache', urls: [url] })).catch(() => {});
      }
    }
    const w = new Worker(src, { type: 'module', name: 'hierarchy' });
    w.onmessage = (ev: MessageEvent<HierarchyResponse>) => this.settle(ev.data.id, ev.data, null);
    w.onerror = (ev) => {
      ev.preventDefault();
      this.failAll(new Error(`hierarchy worker crashed: ${ev.message || 'unknown error'}`));
    };
    this.live = w;
    this.sent.clear();
    return w;
  }

  private settle(id: number, value: HierarchyResponse | null, error: Error | null): void {
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
    this.sent.clear();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    for (const id of [...this.pending.keys()]) this.settle(id, null, error);
  }
}

let shared: HierarchyClient | null = null;

/** The output's one hierarchy worker, shared by every hierarchy layer. */
export function hierarchyClient(): HierarchyClient {
  shared ??= new HierarchyClient();
  return shared;
}
