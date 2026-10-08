import { isPatchOp, type PatchOp } from './patch.ts';
import type { OutputProfile } from './output-profile.ts';
import type { Project, Session } from './project-schema.ts';

/**
 * WebSocket protocol between the server and the two windows. All messages are JSON
 * objects with a `t` discriminator. Everything arriving over the wire is validated by the
 * guards below before use; anything unrecognised is ignored and logged.
 */

/** `preview` is the control window's embedded output: it receives state but reports nothing. */
export type Role = 'control' | 'output' | 'preview';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  /** "server", "output", "control". */
  source: string;
  message: string;
}

export interface OutputStatus {
  fps: number;
  /** Mean CPU time spent in the frame callback, ms. */
  frameMs: number;
  renderer: string;
  vendorOk: boolean;
  contextLost: boolean;
  rev: number;
  layerErrors: { id: string; message: string }[];
  datasetErrors: { id: string; message: string }[];
}

// ---- client -> server ----------------------------------------------------------

export type ClientMessage =
  | { t: 'hello'; role: Role; clientId: string; rev?: number; projectName?: string }
  | { t: 'patch'; ops: PatchOp[] }
  | { t: 'requestFull' }
  | { t: 'openProject'; name: string }
  | { t: 'createProject'; name: string }
  | { t: 'openProfile'; name: string }
  | { t: 'createProfile'; name: string }
  /** Write the open project to disk now (autosave already does this within 0.5 s). */
  | { t: 'saveNow' }
  /** Save As: copy the open project (and its data files) to `name`, then open the copy. */
  | { t: 'duplicateProject'; name: string }
  /** Snapshots: named versions inside the open project (projects/<name>/snapshots/). */
  | { t: 'snapshotCreate'; label: string }
  | { t: 'snapshotRestore'; id: string }
  | { t: 'snapshotDelete'; id: string }
  | { t: 'status'; status: OutputStatus }
  | { t: 'log'; level: LogLevel; message: string }
  | { t: 'pong' };

// ---- server -> client ----------------------------------------------------------

export interface SnapshotInfo {
  id: string;
  label: string;
  /** Server wall-clock ms. */
  createdAt: number;
  layerCount: number;
}

export interface ProjectProblem {
  project: string;
  message: string;
}

export type ServerMessage =
  | {
      t: 'full';
      rev: number;
      projectName: string;
      project: Project;
      session: Session;
      profile: OutputProfile;
    }
  | { t: 'patch'; rev: number; ops: PatchOp[]; origin: string }
  | { t: 'projects'; names: string[]; current: string; problems: ProjectProblem[] }
  | { t: 'profiles'; names: string[]; current: string }
  /** The open project was written to disk (autosave or saveNow), at server wall time `at`. */
  | { t: 'saved'; project: string; at: number }
  /** Snapshots of the open project, newest first. Sent on hello, on change and on project switch. */
  | { t: 'snapshots'; project: string; list: SnapshotInfo[] }
  | { t: 'outputStatus'; clientId: string; status: OutputStatus | null }
  | { t: 'log'; entries: LogEntry[] }
  | { t: 'ping' }
  | { t: 'error'; message: string };

// ---- guards --------------------------------------------------------------------

function obj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isErrorList(v: unknown): boolean {
  return Array.isArray(v) && v.every((e) => obj(e) && str(e.id) && str(e.message));
}

export function isOutputStatus(v: unknown): v is OutputStatus {
  return (
    obj(v) &&
    num(v.fps) &&
    num(v.frameMs) &&
    str(v.renderer) &&
    typeof v.vendorOk === 'boolean' &&
    typeof v.contextLost === 'boolean' &&
    num(v.rev) &&
    isErrorList(v.layerErrors) &&
    isErrorList(v.datasetErrors)
  );
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj(m) || !str(m.t)) return null;
  switch (m.t) {
    case 'hello':
      if ((m.role === 'control' || m.role === 'output' || m.role === 'preview') && str(m.clientId)) {
        return {
          t: 'hello',
          role: m.role,
          clientId: m.clientId,
          ...(num(m.rev) ? { rev: m.rev } : {}),
          ...(str(m.projectName) ? { projectName: m.projectName } : {}),
        };
      }
      return null;
    case 'patch':
      return Array.isArray(m.ops) && m.ops.every(isPatchOp) ? { t: 'patch', ops: m.ops } : null;
    case 'requestFull':
    case 'pong':
      return { t: m.t };
    case 'openProject':
    case 'createProject':
    case 'openProfile':
    case 'createProfile':
    case 'duplicateProject':
      return str(m.name) ? { t: m.t, name: m.name } : null;
    case 'saveNow':
      return { t: 'saveNow' };
    case 'snapshotCreate':
      return str(m.label) ? { t: 'snapshotCreate', label: m.label.slice(0, 120) } : null;
    case 'snapshotRestore':
    case 'snapshotDelete':
      return str(m.id) ? { t: m.t, id: m.id } : null;
    case 'status':
      return isOutputStatus(m.status) ? { t: 'status', status: m.status } : null;
    case 'log':
      return (m.level === 'info' || m.level === 'warn' || m.level === 'error') && str(m.message)
        ? { t: 'log', level: m.level, message: m.message.slice(0, 2000) }
        : null;
    default:
      return null;
  }
}

/**
 * Server messages come from our own server, so the guard is shallow: it checks the
 * discriminator and the fields clients rely on before acting. Project contents are
 * validated separately (ProjectSchema) by consumers that cache them.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj(m) || !str(m.t)) return null;
  switch (m.t) {
    case 'full':
      return num(m.rev) && str(m.projectName) && obj(m.project) && obj(m.session) && obj(m.profile) ? (m as ServerMessage) : null;
    case 'patch':
      return num(m.rev) && str(m.origin) && Array.isArray(m.ops) && m.ops.every(isPatchOp) ? (m as ServerMessage) : null;
    case 'projects':
      return Array.isArray(m.names) && str(m.current) && Array.isArray(m.problems) ? (m as ServerMessage) : null;
    case 'profiles':
      return Array.isArray(m.names) && str(m.current) ? (m as ServerMessage) : null;
    case 'saved':
      return str(m.project) && num(m.at) ? (m as ServerMessage) : null;
    case 'snapshots':
      return str(m.project) && Array.isArray(m.list) ? (m as ServerMessage) : null;
    case 'outputStatus':
      return str(m.clientId) && (m.status === null || isOutputStatus(m.status)) ? (m as ServerMessage) : null;
    case 'log':
      return Array.isArray(m.entries) ? (m as ServerMessage) : null;
    case 'ping':
      return { t: 'ping' };
    case 'error':
      return str(m.message) ? { t: 'error', message: m.message } : null;
    default:
      return null;
  }
}
