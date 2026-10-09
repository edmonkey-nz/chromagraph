import { fitDistance } from './editor-maths.ts';
import type { Camera, Dof } from './project-schema.ts';

/*
 * Camera depth of field (DofSchema), the CPU twin of the shaders in client/output/dof.ts:
 * how far each pixel is from the eye, where the focus plane is, and how much blur that gives.
 * Change both together.
 */

/** Shortest distance (px) over which the blur grows from none to `amount`. */
export const DOF_MIN_RAMP = 50;

/** True when depth of field changes the picture: a 3D camera, switched on, at least half an image pixel of blur. */
export function dofShows(camera: Camera, scale: number): boolean {
  return camera.mode === '3d' && camera.dof.enabled && camera.dof.amount * scale >= 0.5;
}

/**
 * Distance (px, along the view axis) from the eye to the focus plane: the camera's target,
 * moved by `focus`. Both projections orbit at the same eye distance (Stage.setCamera).
 */
export function focusDistance(camera: Camera): number {
  return Math.max(0, fitDistance(camera.fov) * camera.distance + camera.dof.focus);
}

/**
 * Blur in px at 1080p at view distance `z`: none within depth / 2 of the focus plane, then
 * growing linearly over max(depth, DOF_MIN_RAMP) to `amount`. GLSL twin: `cocAt` in
 * client/output/dof.ts.
 */
export function blurAt(z: number, focus: number, dof: Pick<Dof, 'depth' | 'amount'>): number {
  const ramp = Math.max(dof.depth, DOF_MIN_RAMP);
  const t = Math.min(Math.max((Math.abs(z - focus) - dof.depth / 2) / ramp, 0), 1);
  return dof.amount * t;
}

/** View distance from a depth-buffer value (0 at near, 1 at far). GLSL twin: `viewDistance`. */
export function viewDistance(depth: number, near: number, far: number, orthographic: boolean): number {
  return orthographic ? near + depth * (far - near) : (near * far) / (far - depth * (far - near));
}
