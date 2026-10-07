import type { SyncDoc } from '../../shared/project-schema.ts';

const KEY = 'data-wrangler:output-state';
const WRITE_DELAY_MS = 1_000;

export interface CachedState {
  projectName: string;
  rev: number;
  doc: unknown;
}

/** Last full state, so the output can boot and keep rendering without the server. */
export function readCache(): CachedState | null {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    const v = JSON.parse(text) as Partial<CachedState>;
    if (typeof v.projectName !== 'string' || typeof v.rev !== 'number') return null;
    return { projectName: v.projectName, rev: v.rev, doc: v.doc };
  } catch {
    return null;
  }
}

let timer: number | null = null;
let pending: CachedState | null = null;

/** Debounced: localStorage writes are synchronous, so keep them off the frame path. */
export function writeCache(projectName: string, rev: number, doc: SyncDoc): void {
  pending = { projectName, rev, doc };
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      // storage full or blocked: the live state still works, only cold boot loses out
    }
  }, WRITE_DELAY_MS);
}
