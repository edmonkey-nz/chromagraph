import { isPatchOp, type PatchOp } from './patch.ts';
import type { Project, Session } from './project-schema.ts';

/**
 * WebSocket protocol between the server and the two windows. All messages are JSON
 * objects with a `t` discriminator. Everything arriving over the wire is validated by the
 * guards below before use; anything unrecognised is ignored and logged.
 */

export type Role = 'control' | 'output';

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
  | { t: 'status'; status: OutputStatus }
  | { t: 'log'; level: LogLevel; message: string }
  | { t: 'pong' };

// ---- server -> client ----------------------------------------------------------

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
    }
  | { t: 'patch'; rev: number; ops: PatchOp[]; origin: string }
  | { t: 'projects'; names: string[]; current: string; problems: ProjectProblem[] }
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
      if ((m.role === 'control' || m.role === 'output') && str(m.clientId)) {
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
      return str(m.name) ? { t: m.t, name: m.name } : null;
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
      return num(m.rev) && str(m.projectName) && obj(m.project) && obj(m.session) ? (m as ServerMessage) : null;
    case 'patch':
      return num(m.rev) && str(m.origin) && Array.isArray(m.ops) && m.ops.every(isPatchOp) ? (m as ServerMessage) : null;
    case 'projects':
      return Array.isArray(m.names) && str(m.current) && Array.isArray(m.problems) ? (m as ServerMessage) : null;
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
