import { FRAME_CENTRE, type LayerTransform } from './layer-schema.ts';
import { defaultDof, type Camera } from './project-schema.ts';

/**
 * Pure maths for the preview's direct-manipulation editor (gizmo and orbit camera). Plain
 * arrays only, so it stays free of three.js objects and is easy to test.
 */

export type V3 = [number, number, number];

const DEG = Math.PI / 180;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;

/** Pitch limits of the camera schema, degrees. */
export const PITCH_LIMIT = 89;

/** Camera distance (px) at which the z = 0 plane exactly fills the frame for a given fov. */
export function fitDistance(fovDeg: number): number {
  return OUTPUT_HEIGHT / 2 / Math.tan((fovDeg * DEG) / 2);
}

/**
 * Half the width and height (px) of the isometric (orthographic) camera's view: at distance 1
 * the target's plane fills the 1920x1080 frame exactly, as the perspective camera's z = 0
 * plane does at yaw = pitch = 0, and the view grows with distance (zooming out shows more).
 */
export function isometricHalfSize(distance: number): [number, number] {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 1;
  return [(OUTPUT_WIDTH / 2) * d, (OUTPUT_HEIGHT / 2) * d];
}

/**
 * How far the isometric camera reaches either side of its eye (px). The eye sits where the
 * perspective camera's would (so orbiting and the gizmo behave alike) and the near plane lies
 * behind it, so a scene up to this far from the target is never clipped however far the
 * view is zoomed in.
 */
export const ISOMETRIC_DEPTH = 40_000;

/**
 * World-space eye and look-at point of a 3D camera config. Mirrors `Stage.setCamera`
 * exactly (a test checks the two agree).
 */
export function orbitFromCamera(cfg: Camera): { position: V3; target: V3 } {
  const r = fitDistance(cfg.fov) * cfg.distance;
  const yaw = cfg.yaw * DEG;
  const pitch = cfg.pitch * DEG;
  const target: V3 = [FRAME_CENTRE[0] + cfg.target[0], FRAME_CENTRE[1] + cfg.target[1], FRAME_CENTRE[2] + cfg.target[2]];
  return {
    position: [
      target[0] + r * Math.sin(yaw) * Math.cos(pitch),
      target[1] + r * Math.sin(pitch),
      target[2] + r * Math.cos(yaw) * Math.cos(pitch),
    ],
    target,
  };
}

/**
 * Inverse of `orbitFromCamera`: a 3D camera config from an eye and look-at point. Yaw is
 * unwrapped to the turn nearest `refYaw`, so dragging past ±180° keeps counting rather
 * than jumping; pitch is clamped to the schema's ±89°. Values are rounded (0.001°,
 * 1e-5 distance, 0.01 px) so patches stay readable. `projection` is passed through (an
 * isometric view stays isometric while orbiting; its distance is the zoom), and so is `dof`
 * (copied, so the result never shares it). Returns null for
 * a degenerate camera (eye on the target).
 */
export function cameraFromOrbit(
  position: readonly number[],
  target: readonly number[],
  fov: number,
  refYaw = 0,
  projection: Camera['projection'] = 'perspective',
  dof: Camera['dof'] = defaultDof(),
): Camera | null {
  const dx = (position[0] ?? 0) - (target[0] ?? 0);
  const dy = (position[1] ?? 0) - (target[1] ?? 0);
  const dz = (position[2] ?? 0) - (target[2] ?? 0);
  const r = Math.hypot(dx, dy, dz);
  if (!(r > 1e-9) || !Number.isFinite(r)) return null;
  const pitch = Math.asin(Math.max(-1, Math.min(1, dy / r))) / DEG;
  const yaw = Math.atan2(dx, dz) / DEG;
  return {
    mode: '3d',
    projection,
    dof: { ...dof },
    fov,
    yaw: round(unwrapDegrees(yaw, refYaw), 1000),
    pitch: round(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch)), 1000),
    distance: Math.max(1e-5, round(r / fitDistance(fov), 100_000)),
    target: [
      round((target[0] ?? 0) - FRAME_CENTRE[0], 100),
      round((target[1] ?? 0) - FRAME_CENTRE[1], 100),
      round((target[2] ?? 0) - FRAME_CENTRE[2], 100),
    ],
  };
}

/** The same angle (mod 360) as `value`, chosen nearest to `reference`. */
export function unwrapDegrees(value: number, reference: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return value;
  return value + 360 * Math.round((reference - value) / 360);
}

/**
 * Where the gizmo proxy sits for a layer transform. The layer matrix is
 *   M = T(position + pivot) * R * S * T(-pivot)
 * so a proxy at (position + pivot) with the layer's rotation and scale gives
 * M = proxy * T(-pivot). Rotation is returned in radians (Euler XYZ).
 */
export function proxyFromTransform(t: LayerTransform): { position: V3; rotation: V3; scale: V3 } {
  return {
    position: [t.position[0] + t.pivot[0], t.position[1] + t.pivot[1], t.position[2] + t.pivot[2]],
    rotation: [t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG],
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  };
}

/**
 * Inverse of `proxyFromTransform`. Each rotation angle is unwrapped towards the matching
 * angle of `refRotation` (degrees), which keeps the same rotation but avoids jumps such as
 * 350° -> -10°. Values are rounded so patches stay readable (0.01 px, 0.01°, 1e-4 scale).
 */
export function transformFromProxy(
  position: readonly number[],
  rotationRad: readonly number[],
  scale: readonly number[],
  pivot: readonly [number, number, number],
  refRotation: readonly [number, number, number] = [0, 0, 0],
): LayerTransform {
  const at = (a: readonly number[], i: number, fallback: number) => {
    const v = a[i];
    return v !== undefined && Number.isFinite(v) ? v : fallback;
  };
  const rot = (i: 0 | 1 | 2) => round(unwrapDegrees(at(rotationRad, i, 0) / DEG, refRotation[i]), 100);
  return {
    position: [round(at(position, 0, 0) - pivot[0], 100), round(at(position, 1, 0) - pivot[1], 100), round(at(position, 2, 0) - pivot[2], 100)],
    rotation: [rot(0), rot(1), rot(2)],
    scale: [round(at(scale, 0, 1), 10_000), round(at(scale, 1, 1), 10_000), round(at(scale, 2, 1), 10_000)],
    pivot: [pivot[0], pivot[1], pivot[2]],
  };
}

function round(v: number, per: number): number {
  const r = Math.round(v * per) / per;
  return r === 0 ? 0 : r; // no -0 in patches
}

/** Snap step for the gizmo, from the protocol's `snap` (0 = off). */
export function gizmoSnap(mode: 'translate' | 'rotate' | 'scale', snap: number): number | null {
  if (!(snap > 0) || !Number.isFinite(snap)) return null;
  if (mode === 'rotate') return snap * DEG;
  // Scale snaps in 0.05 steps; a snap value below 1 is taken as the step itself.
  if (mode === 'scale') return snap < 1 ? snap : 0.05;
  return snap;
}

/**
 * Leading-edge throttle with a trailing call: the first value is sent at once, later ones
 * at most every `intervalMs`, and the latest pending value is always delivered. `flush`
 * cancels anything pending (used before a final message). Clock and timer are injectable
 * for tests.
 */
export class Throttle<T> {
  private last = -Infinity;
  private pending: { value: T } | null = null;
  private timer: unknown = null;

  constructor(
    private intervalMs: number,
    private send: (value: T) => void,
    private now: () => number = () => Date.now(),
    private schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  push(value: T): void {
    const t = this.now();
    if (t - this.last >= this.intervalMs && this.timer === null) {
      this.last = t;
      this.send(value);
      return;
    }
    this.pending = { value };
    if (this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        const p = this.pending;
        this.pending = null;
        if (p) {
          this.last = this.now();
          this.send(p.value);
        }
      }, Math.max(0, this.intervalMs - (t - this.last)));
    }
  }

  /** Drop any pending value and reset, so the next push goes straight out. */
  clear(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending = null;
    this.last = -Infinity;
  }
}
