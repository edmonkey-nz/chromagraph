import { FRAME_CENTRE, type LineLayer } from './layer-schema.ts';
import { applyOps, type PatchOp } from './patch.ts';
import type { CameraFollow, OrbitCamera, Project } from './project-schema.ts';
import { readReveal, revealOps } from './reveal.ts';

/**
 * Follow camera maths (CameraFollowSchema). Pure; the output calls these every frame with the
 * followed line's newest visible point in world space.
 */

export type V3 = [number, number, number];

/**
 * Road view: behind the point and a little to one side (looking along +x), a little above, close.
 * Straight behind (yaw -90) would see the chart edge on: every point on one vertical line.
 */
export const ROAD_VIEW = { yaw: -70, pitch: 14, distance: 0.35 } as const;

/**
 * Where the camera should look for a tip at `tip` (world px): `lead` px ahead along x, the tip's
 * depth, and a height between the camera target's (a flat road) and the tip's, by `height`.
 */
export function followGoal(tip: readonly number[], base: Pick<OrbitCamera, 'target'>, f: Pick<CameraFollow, 'height' | 'lead'>, out: V3): V3 {
  const flatY = FRAME_CENTRE[1] + base.target[1];
  out[0] = (tip[0] ?? 0) + f.lead;
  out[1] = flatY + f.height * ((tip[1] ?? 0) - flatY);
  out[2] = tip[2] ?? 0;
  return out;
}

/**
 * Move `state` towards `goal` over `dt` seconds, closing 1 - e^-1 (about 63 %) of the distance
 * every `seconds`: frame-rate independent, so it looks the same at 30 and 144 fps. `seconds`
 * 0 snaps.
 */
export function easeToward(state: V3, goal: readonly number[], dt: number, seconds: number): V3 {
  const k = seconds > 0 ? 1 - Math.exp(-Math.max(0, dt) / seconds) : 1;
  for (let i = 0; i < 3; i++) state[i] = state[i]! + ((goal[i] ?? 0) - state[i]!) * k;
  return state;
}

/**
 * How far the newest point must jump back along x in one frame (world px) to count as the line
 * starting again (a looping reveal restarting), which starts the loop flight.
 */
export const RESTART_JUMP_PX = 200;

/** Offsets to the camera's own view during a loop flight, and how far the look-at point has moved. */
export interface FlightPose {
  /** 0..1: share of the way from where the flight began to the line's newest point. */
  mix: number;
  /** Degrees added to yaw (whole turns by the end, so the view lands where it was). */
  yaw: number;
  /** Degrees added to pitch (up midway, back to 0). */
  pitch: number;
  /** Multiplier on distance (out midway, back to 1). */
  distanceScale: number;
}

/** Highest the flight rises (degrees of pitch) and how far it pulls out (share of the distance), midway. */
const FLIGHT_RISE = 25;
const FLIGHT_PULL = 0.8;

/**
 * The loop flight at progress u (0..1) with `turns` circles: eased (slow start and landing),
 * circling the look-at point, rising and pulling out most at the middle, ending exactly on the
 * plain follow view (every offset back to zero, yaw by whole turns).
 */
export function flightPose(u: number, turns: number, out: FlightPose): FlightPose {
  const t = Math.min(1, Math.max(0, u));
  const e = t * t * (3 - 2 * t);
  const arc = Math.sin(Math.PI * t);
  out.mix = e;
  out.yaw = 360 * turns * e;
  out.pitch = FLIGHT_RISE * arc;
  out.distanceScale = 1 + FLIGHT_PULL * arc;
  return out;
}

/** Share of the way from a line's colour to the background when it becomes the dimmed path. */
const PATH_DIM = 0.6;

/** `a` moved `t` of the way to `b` (#rrggbb). */
function mixHex(a: string, b: string, t: number): string {
  const n = (s: string, i: number) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
  const c = [0, 1, 2].map((i) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * "Follow path": the patch that sets a line up to be followed with its path ahead in view. The
 * line itself becomes the path (its whole range shown, dimmed towards the background); a copy on
 * top (named "<name> · follow path", one px wider, no axes) builds up over the timeline from the
 * start of that range; and the camera follows the copy (switched to 3D in Road view if it was 2D).
 * Returns [] for anything but a line. `newId` names the copy.
 */
export function followPathOps(project: Project, lineId: string, newId: string): PatchOp[] {
  const index = project.layers.findIndex((l) => l.id === lineId);
  const line = project.layers[index];
  if (!line || line.type !== 'line') return [];
  const was = readReveal(project, line);
  const start = was?.start ?? line.rows[0];
  const end = was?.end ?? line.rows[1];
  const copy: LineLayer = {
    ...structuredClone(line),
    id: newId,
    name: `${line.name} · follow path`,
    width: Math.min(200, line.width + 1),
    axes: { ...line.axes, values: { ...line.axes.values, enabled: false }, x: { ...line.axes.x, enabled: false }, y: { ...line.axes.y, enabled: false } },
  };
  const ops: PatchOp[] = [
    { op: 'set', path: ['project', 'layers', index, 'colour'], value: mixHex(line.colour, project.output.background, PATH_DIM) },
    { op: 'set', path: ['project', 'layers', project.layers.length], value: copy },
  ];
  // The path shows its whole range; the copy builds up over it. (Ops address the synced document.)
  const after = (list: PatchOp[]): Project => applyOps({ project }, list).project;
  ops.push(...revealOps(after(ops), lineId, { mode: 'off', start, end, from: start, width: 0.1, easing: 'linear' }));
  ops.push(...revealOps(after(ops), newId, { mode: 'build', start, end, from: start, width: 0.1, easing: was?.mode === 'build' ? was.easing : 'linear' }));
  const set = (path: (string | number)[], value: unknown): PatchOp => ({ op: 'set', path: ['project', 'camera', ...path], value });
  ops.push(set(['follow', 'layerId'], newId), set(['follow', 'enabled'], true));
  if (project.camera.mode === '2d') {
    ops.push(set(['mode'], '3d'), set(['projection'], 'perspective'), set(['yaw'], ROAD_VIEW.yaw), set(['pitch'], ROAD_VIEW.pitch), set(['distance'], ROAD_VIEW.distance));
  }
  return ops;
}
