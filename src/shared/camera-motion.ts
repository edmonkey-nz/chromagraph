import type { Modulator, Parameter } from './modulators.ts';
import type { PatchOp } from './patch.ts';
import type { Project } from './project-schema.ts';

/**
 * Camera motion presets: ready-made camera moves (orbit, zoom, pan, …) built from ordinary
 * modulators on the camera parameters, so the output needs nothing new and the moves are
 * saved, captured by scenes and editable in the Modulation card like any other.
 *
 * Only LFO and noise are used: they add to the camera's base value, so the framing set in
 * the Camera card (or by dragging in the preview) stays the centre of the move. A preset owns
 * every camera.* modulator: applying one replaces them all.
 *
 * Speed scales every move: LFO periods are divided by it, noise speeds multiplied. LFO values
 * come from wall-clock time / period, so a new period alone would make the camera jump; the
 * new LFO gets the phase that continues the old one's cycle from `nowMs` instead. (Noise has
 * no phase, so the drift preset can shift slightly when its speed changes.)
 *
 * The preset and speed are not stored; detectCameraMotion() reads them back from the
 * modulators (ignoring phase), and reports 'custom' once a camera modulator has been edited
 * by hand.
 */

export const CAMERA_MOTIONS = ['none', 'orbit', 'orbit-reverse', 'swing', 'orbit-bob', 'zoom', 'pan', 'tilt', 'drift', 'fly-around'] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

export const CAMERA_MOTION_TITLES: Record<CameraMotion, string> = {
  none: 'none',
  orbit: 'orbit (1 turn / min)',
  'orbit-reverse': 'orbit, reverse',
  swing: 'swing left–right',
  'orbit-bob': 'orbit + bob',
  zoom: 'zoom in–out',
  pan: 'pan left–right',
  tilt: 'tilt up–down',
  drift: 'drift (handheld)',
  'fly-around': 'fly-around',
};

export const SPEED_MIN = 0.05;
export const SPEED_MAX = 5;
export const SPEED_STEP = 0.05;

const lfo = (shape: 'sine' | 'saw', period: number, amount: number, speed: number): Modulator => ({
  kind: 'lfo',
  enabled: true,
  shape,
  period: period / speed,
  phase: 0,
  amount,
});

const noise = (amount: number, rate: number, seed: number, speed: number): Modulator => ({
  kind: 'noise',
  enabled: true,
  amount,
  speed: rate * speed,
  seed,
});

/** The camera modulators of `motion` at `speed` (1 = the preset's own pace). */
export function cameraMotionModulators(motion: CameraMotion, speed: number): Record<string, Modulator> {
  const s = clampSpeed(speed);
  switch (motion) {
    case 'none':
      return {};
    case 'orbit':
      // A saw over ±180°: the wrap from +180 to -180 is the same view, so it turns forever.
      return { 'camera.yaw': lfo('saw', 60, 180, s) };
    case 'orbit-reverse':
      return { 'camera.yaw': lfo('saw', 60, -180, s) };
    case 'swing':
      return { 'camera.yaw': lfo('sine', 20, 35, s) };
    case 'orbit-bob':
      return { 'camera.yaw': lfo('saw', 60, 180, s), 'camera.pitch': lfo('sine', 17, 12, s) };
    case 'zoom':
      return { 'camera.distance': lfo('sine', 16, 0.35, s) };
    case 'pan':
      return { 'camera.target.0': lfo('sine', 24, 400, s) };
    case 'tilt':
      return { 'camera.pitch': lfo('sine', 20, 25, s) };
    case 'drift':
      return {
        'camera.yaw': noise(12, 0.08, 101, s),
        'camera.pitch': noise(6, 0.06, 202, s),
        'camera.distance': noise(0.08, 0.05, 303, s),
        'camera.target.0': noise(60, 0.05, 404, s),
        'camera.target.1': noise(40, 0.05, 505, s),
      };
    case 'fly-around':
      return {
        'camera.yaw': lfo('saw', 90, 180, s),
        'camera.pitch': lfo('sine', 31, 20, s),
        'camera.distance': lfo('sine', 23, 0.3, s),
      };
  }
}

const fract = (x: number): number => x - Math.floor(x);

/** Phase for an LFO of `period` that is at the same point of its cycle at `nowMs` as the old one (see evaluate). */
export function continuedPhase(oldPeriod: number, oldPhase: number, period: number, nowMs: number): number {
  const at = fract((nowMs % (oldPeriod * 1000)) / (oldPeriod * 1000) + oldPhase);
  return fract(at - (nowMs % (period * 1000)) / (period * 1000));
}

export function clampSpeed(speed: number): number {
  return Math.min(Math.max(Number.isFinite(speed) ? speed : 1, SPEED_MIN), SPEED_MAX);
}

function isCameraParam(id: string): boolean {
  return id.startsWith('camera.');
}

/**
 * Ops that make `motion` at `speed` the camera's only modulators. Choosing a move switches a
 * 2D camera to 3D, since the moves only show with the 3D camera. With `nowMs` (wall clock),
 * an LFO replacing one of the same shape and amount continues its cycle (no jump).
 */
export function cameraMotionOps(
  project: Pick<Project, 'parameters' | 'camera'>,
  motion: CameraMotion,
  speed: number,
  nowMs: number | null = null,
): PatchOp[] {
  const want = cameraMotionModulators(motion, speed);
  if (nowMs !== null) {
    for (const [id, m] of Object.entries(want)) {
      const old = project.parameters[id]?.modulator;
      if (m.kind === 'lfo' && old?.kind === 'lfo' && old.enabled && old.shape === m.shape && old.amount === m.amount) {
        m.phase = continuedPhase(old.period, old.phase, m.period, nowMs);
      }
    }
  }
  const ops: PatchOp[] = [];
  for (const id of Object.keys(project.parameters)) {
    if (isCameraParam(id) && !(id in want)) ops.push({ op: 'remove', path: ['project', 'parameters', id] });
  }
  for (const [id, modulator] of Object.entries(want)) {
    ops.push({ op: 'set', path: ['project', 'parameters', id], value: { modulator } });
  }
  if (motion !== 'none' && project.camera.mode !== '3d') ops.push({ op: 'set', path: ['project', 'camera', 'mode'], value: '3d' });
  return ops;
}

/** The preset (and speed) the camera's modulators match, or 'custom' with speed null. */
export function detectCameraMotion(parameters: Readonly<Record<string, Parameter>>): { motion: CameraMotion | 'custom'; speed: number | null } {
  const current: Record<string, Modulator> = {};
  for (const [id, p] of Object.entries(parameters)) if (isCameraParam(id)) current[id] = p.modulator;
  if (Object.keys(current).length === 0) return { motion: 'none', speed: null };
  for (const motion of CAMERA_MOTIONS) {
    if (motion === 'none') continue;
    const at1 = cameraMotionModulators(motion, 1);
    const ids = Object.keys(at1);
    if (ids.length !== Object.keys(current).length || !ids.every((id) => id in current)) continue;
    const first = at1[ids[0]!]!;
    const seen = current[ids[0]!]!;
    let speed: number;
    if (first.kind === 'lfo' && seen.kind === 'lfo') speed = first.period / seen.period;
    else if (first.kind === 'noise' && seen.kind === 'noise') speed = seen.speed / first.speed;
    else continue;
    speed = Math.round(speed / SPEED_STEP) * SPEED_STEP;
    if (sameModulators(cameraMotionModulators(motion, speed), current)) return { motion, speed: clampSpeed(speed) };
  }
  return { motion: 'custom', speed: null };
}

function sameModulators(a: Record<string, Modulator>, b: Record<string, Modulator>): boolean {
  for (const [id, ma] of Object.entries(a)) {
    const mb = b[id];
    if (!mb || ma.kind !== mb.kind || ma.enabled !== mb.enabled) return false;
    for (const [k, v] of Object.entries(ma)) {
      if (k === 'phase') continue; // set to continue a cycle when the speed changes
      const w = (mb as Record<string, unknown>)[k];
      if (typeof v === 'number' ? typeof w !== 'number' || Math.abs(v - w) > 1e-6 * Math.max(1, Math.abs(v)) : v !== w) return false;
    }
  }
  return true;
}
