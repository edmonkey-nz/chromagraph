import type { PatchOp } from './patch.ts';
import { PROJECT_NAME_RE } from './project-schema.ts';
import type { SnapshotInfo } from './protocol.ts';

/**
 * Pure helpers for the control window's Save UI: the "Saved hh:mm:ss / Unsaved…"
 * indicator, project-name checks for New and Save As, and snapshot labels.
 */

/** True when any op changes the saved project (session and profile changes are not project saves). */
export function touchesProject(ops: readonly PatchOp[]): boolean {
  return ops.some((o) => o.path[0] === 'project');
}

/** After this long without a `saved` message, an unsaved change is shown as a warning. */
export const SAVE_OVERDUE_MS = 5_000;

export type SaveState =
  /** No change since the project was opened (or since the last known save). */
  | { kind: 'clean'; savedAt: number | null }
  /** Changes sent or received that no `saved` message has covered yet. */
  | { kind: 'dirty'; since: number; overdue: boolean };

/**
 * Tracks whether the open project has changes the server has not yet written. Our own
 * project patches count from the moment they are sent (in flight) until their echo comes
 * back; any project change counts until the next `saved` message. A `saved` that arrives
 * while our own patches are still in flight does not clear the state, because that write
 * cannot include them.
 */
export class SaveTracker {
  private savedAt: number | null = null;
  private dirtySince: number | null = null;
  private inFlight = 0;

  /** A new project was opened (or a full resync arrived): forget everything. */
  reset(): void {
    this.savedAt = null;
    this.dirtySince = null;
    this.inFlight = 0;
  }

  /** We sent a patch that changes the project. */
  sent(nowMs: number): void {
    this.inFlight++;
    this.dirtySince ??= nowMs;
  }

  /** A project-changing patch was applied; `own` when it is the echo of one we sent. */
  changed(own: boolean, nowMs: number): void {
    if (own && this.inFlight > 0) this.inFlight--;
    this.dirtySince ??= nowMs;
  }

  /** A full snapshot replaced our state: patches in flight were either applied or rejected. */
  resynced(): void {
    this.inFlight = 0;
  }

  /** The server wrote the project at server time `at`. */
  saved(at: number): void {
    this.savedAt = at;
    if (this.inFlight === 0) this.dirtySince = null;
  }

  state(nowMs: number): SaveState {
    if (this.dirtySince === null) return { kind: 'clean', savedAt: this.savedAt };
    return { kind: 'dirty', since: this.dirtySince, overdue: nowMs - this.dirtySince > SAVE_OVERDUE_MS };
  }
}

/** "14:03:22" in 24-hour local time. */
export function formatClockTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-NZ', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

/** Indicator text for a save state. */
export function saveLabel(s: SaveState, timeZone?: string): string {
  if (s.kind === 'dirty') return s.overdue ? 'Not saved yet' : 'Unsaved…';
  return s.savedAt === null ? 'No unsaved changes' : `Saved ${formatClockTime(s.savedAt, timeZone)}`;
}

/**
 * Check a name for a new project or a Save As copy. Returns an error message, or null
 * when the name is usable. Names are compared case-insensitively, because project folders
 * may live on a case-insensitive file system.
 */
export function projectNameError(name: string, existing: readonly string[]): string | null {
  if (name.length === 0) return 'Enter a name.';
  if (!PROJECT_NAME_RE.test(name)) return 'Use letters, digits, spaces, "-" and "_" (up to 64 characters), starting with a letter or digit.';
  const lower = name.toLowerCase();
  if (existing.some((n) => n.toLowerCase() === lower)) return `A project called "${name}" already exists.`;
  return null;
}

/** "Save As" suggestion: "<name> copy", then "<name> copy 2", … that doesn't exist yet. */
export function suggestCopyName(name: string, existing: readonly string[]): string {
  const base = `${name} copy`.slice(0, 58).trimEnd();
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Snapshot labels are trimmed, single-line and at most 120 characters (the server's limit). */
export function cleanSnapshotLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** "3 layers · 9 Oct, 14:03" (the label is shown separately). */
export function snapshotSummary(s: SnapshotInfo, timeZone?: string): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(s.createdAt);
  } catch {
    when = new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  }
  return `${s.layerCount} layer${s.layerCount === 1 ? '' : 's'} · ${when}`;
}
