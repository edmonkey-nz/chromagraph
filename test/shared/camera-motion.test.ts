import { describe, expect, it } from 'vitest';
import { CAMERA_MOTIONS, cameraMotionModulators, cameraMotionOps, detectCameraMotion } from '../../src/shared/camera-motion.ts';
import { evaluate } from '../../src/shared/modulators.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, ProjectSchema } from '../../src/shared/project-schema.ts';

const project = () => defaultProject('t');

/** Apply ops to a project the way the hub does (doc root { project }). */
function applied(p: ReturnType<typeof project>, ops: ReturnType<typeof cameraMotionOps>) {
  return applyOps({ project: p }, ops).project;
}

describe('camera motion presets', () => {
  it('every preset at every speed is a valid project, and is detected back', () => {
    for (const motion of CAMERA_MOTIONS) {
      for (const speed of [0.05, 0.35, 1, 2.5, 5]) {
        const p = applied(project(), cameraMotionOps(project(), motion, speed));
        expect(ProjectSchema.safeParse(p).success, `${motion} @ ${speed}`).toBe(true);
        const got = detectCameraMotion(p.parameters);
        expect(got.motion).toBe(motion);
        if (motion !== 'none') expect(got.speed).toBeCloseTo(speed, 6);
      }
    }
  });

  it('speed divides LFO periods and multiplies noise speeds', () => {
    const orbit = cameraMotionModulators('orbit', 2)['camera.yaw'];
    expect(orbit).toMatchObject({ kind: 'lfo', shape: 'saw', period: 30, amount: 180 });
    const drift = cameraMotionModulators('drift', 2)['camera.yaw'];
    expect(drift).toMatchObject({ kind: 'noise', speed: 0.16 });
  });

  it('replaces every camera modulator, keeps layer ones, and switches to 3D', () => {
    const p = project();
    p.parameters['camera.fov'] = { modulator: { kind: 'lfo', enabled: true, shape: 'sine', period: 5, phase: 0, amount: 3 } };
    p.parameters['layer.a.opacity'] = { modulator: { kind: 'lfo', enabled: true, shape: 'sine', period: 5, phase: 0, amount: 0.2 } };
    const next = applied(p, cameraMotionOps(p, 'zoom', 1));
    expect(Object.keys(next.parameters).sort()).toEqual(['camera.distance', 'layer.a.opacity']);
    expect(next.camera.mode).toBe('3d');
    const cleared = applied(next, cameraMotionOps(next, 'none', 1));
    expect(Object.keys(cleared.parameters)).toEqual(['layer.a.opacity']);
    expect(cleared.camera.mode).toBe('3d'); // 'none' leaves the camera mode alone
  });

  it('changing speed continues the move instead of jumping', () => {
    const now = 1_791_457_234_694.25; // a real wall-clock time: hours of cycles have passed
    const slow = applied(project(), cameraMotionOps(project(), 'orbit-bob', 1, now));
    const fast = applied(slow, cameraMotionOps(slow, 'orbit-bob', 2.35, now));
    for (const id of ['camera.yaw', 'camera.pitch']) {
      const before = evaluate(slow.parameters[id]!.modulator, 0, now, 0);
      const after = evaluate(fast.parameters[id]!.modulator, 0, now, 0);
      expect(after, id).toBeCloseTo(before, 6);
    }
    expect(detectCameraMotion(fast.parameters)).toEqual({ motion: 'orbit-bob', speed: 2.35 });
  });

  it('a hand-edited camera modulator reads as custom', () => {
    const p = applied(project(), cameraMotionOps(project(), 'orbit', 1));
    const m = p.parameters['camera.yaw']!.modulator;
    if (m.kind === 'lfo') m.amount = 90;
    expect(detectCameraMotion(p.parameters)).toEqual({ motion: 'custom', speed: null });
  });
});
