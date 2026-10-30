import type { GizmoMode, PreviewToControl } from './editor-protocol.ts';
import { TransformSchema, type LayerTransform } from './layer-schema.ts';
import type { PatchOp } from './patch.ts';
import { CameraSchema, type Camera, type Project } from './project-schema.ts';

/**
 * Pure helpers for the control side of the preview editor (`editor-protocol.ts`): snap
 * sizes, validating what the preview sends, turning it into patches, and throttling.
 * No DOM, so they are tested in Node.
 */

export const GIZMO_MODES = ['translate', 'rotate', 'scale'] as const satisfies readonly GizmoMode[];

/** Gizmo mode titles and their keyboard shortcuts (as in most 3D editors). */
export const GIZMO_TITLES: Record<GizmoMode, { title: string; key: string }> = {
  translate: { title: 'Move', key: 'w' },
  rotate: { title: 'Rotate', key: 'e' },
  scale: { title: 'Scale', key: 'r' },
};

export const SNAP_LEVELS = ['off', 'small', 'large'] as const;
export type SnapLevel = (typeof SNAP_LEVELS)[number];

/** Snap per mode and level: px for translate, degrees for rotate, scale step for scale. */
const SNAP: Record<GizmoMode, Record<Exclude<SnapLevel, 'off'>, number>> = {
  translate: { small: 10, large: 50 },
  rotate: { small: 5, large: 15 },
  scale: { small: 0.05, large: 0.25 },
};

/** The `snap` value of an `edit` message (0 = off). */
export function snapFor(mode: GizmoMode, level: SnapLevel): number {
  return level === 'off' ? 0 : SNAP[mode][level];
}

/** Human-readable snap, e.g. "10 px", "15°", "0.05". */
export function snapLabel(mode: GizmoMode, level: SnapLevel): string {
  const v = snapFor(mode, level);
  if (v === 0) return 'off';
  return mode === 'translate' ? `${v} px` : mode === 'rotate' ? `${v}°` : String(v);
}

/** Gizmo mode for a key press ("w", "e", "r", any case), or null. */
export function gizmoModeForKey(key: string): GizmoMode | null {
  const k = key.toLowerCase();
  for (const mode of GIZMO_MODES) if (GIZMO_TITLES[mode].key === k) return mode;
  return null;
}

/**
 * A preview -> control message with its fields checked (shapes only; transform and camera
 * values are validated against the schemas when they are turned into patches). Null for
 * anything else.
 */
export function parsePreviewMessage(msg: unknown): PreviewToControl | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const final = m.final === true;
  switch (m.t) {
    case 'ready':
      return { t: 'ready' };
    case 'transform':
      if (typeof m.layerId !== 'string' || typeof m.transform !== 'object' || m.transform === null) return null;
      return { t: 'transform', layerId: m.layerId, transform: m.transform as LayerTransform, final };
    case 'camera':
      if (typeof m.camera !== 'object' || m.camera === null) return null;
      return { t: 'camera', camera: m.camera as Camera, final };
    case 'select':
      if (m.layerId !== null && typeof m.layerId !== 'string') return null;
      return { t: 'select', layerId: m.layerId };
    default:
      return null;
  }
}

function sameNumbers(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Patch setting a layer's transform, with the layer's index resolved from `project` now.
 * Null when the transform is invalid, the layer is gone, or nothing would change.
 */
export function transformPatch(project: Project, layerId: string, transform: unknown): PatchOp[] | null {
  const parsed = TransformSchema.safeParse(transform);
  if (!parsed.success) return null;
  const index = project.layers.findIndex((l) => l.id === layerId);
  const layer = project.layers[index];
  if (!layer || sameNumbers(layer.transform, parsed.data)) return null;
  return [{ op: 'set', path: ['project', 'layers', index, 'transform'], value: parsed.data }];
}

/** Patch setting the camera. Null when the camera is invalid or nothing would change. */
export function cameraPatch(project: Project, camera: unknown): PatchOp[] | null {
  // Orbit editing never changes the follow setting: keep the project's.
  const parsed = CameraSchema.safeParse(camera && typeof camera === 'object' ? { ...camera, follow: project.camera.follow } : camera);
  if (!parsed.success || sameNumbers(project.camera, parsed.data)) return null;
  return [{ op: 'set', path: ['project', 'camera'], value: parsed.data }];
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Passes on at most one value per `intervalMs`, always the latest. A value pushed inside the
 * interval waits (replacing any value already waiting) and goes out when the interval ends;
 * a `final` value goes out at once, dropping whatever was waiting.
 */
export class LatestThrottle<T> {
  private lastMs = -Infinity;
  private pending: { value: T } | null = null;
  private timer: unknown = null;

  constructor(
    private intervalMs: number,
    private emit: (value: T) => void,
    private clock: Clock = realClock,
  ) {}

  push(value: T, final = false): void {
    const now = this.clock.now();
    if (final || now - this.lastMs >= this.intervalMs) {
      this.cancel();
      this.fire(value, now);
      return;
    }
    this.pending = { value };
    if (this.timer === null) {
      this.timer = this.clock.setTimeout(() => this.flush(), this.intervalMs - (now - this.lastMs));
    }
  }

  /** Send anything waiting now. */
  flush(): void {
    const p = this.pending;
    this.cancel();
    if (p) this.fire(p.value, this.clock.now());
  }

  /** Drop anything waiting. */
  cancel(): void {
    this.pending = null;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(value: T, now: number): void {
    this.lastMs = now;
    this.emit(value);
  }
}
