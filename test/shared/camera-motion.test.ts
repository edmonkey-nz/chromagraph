import { describe, expect, it } from 'vitest';
import { CAMERA_MOTIONS, cameraLoopSeconds, cameraMotionModulators, cameraMotionOps, detectCameraMotion, NOISE_WINDOW_SECONDS } from '../../src/shared/camera-motion.ts';
import { paramClockMs } from '../../src/shared/modulation-helpers.ts';
import { clockMs, evaluate, WALL_CLOCK, type Modulator } from '../../src/shared/modulators.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, defaultSession, ProjectSchema, SessionSchema } from '../../src/shared/project-schema.ts';

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

  /** Project and session after `ops`, the way the hub applies them. */
  const both = (p: ReturnType<typeof project>, session: ReturnType<typeof defaultSession>, ops: ReturnType<typeof cameraMotionOps>) => applyOps({ project: p, session }, ops);
  /** Every camera parameter's value (base 0) at wall time `now`, as the output computes it. */
  const values = (doc: ReturnType<typeof both>, now: number) =>
    Object.entries(doc.project.parameters).map(([id, p]) => evaluate(p.modulator, 0, paramClockMs(doc.session, id, now), 0));

  it('changing speed continues the move instead of jumping, noise included', () => {
    const now = 1_791_457_234_694.25; // a real wall-clock time: hours of cycles have passed
    for (const motion of ['orbit-bob', 'drift', 'fly-around'] as const) {
      const s0 = defaultSession(0);
      const slow = both(project(), s0, cameraMotionOps(project(), motion, 1, { clock: s0.cameraClock, nowMs: now - 5000 }));
      // Five seconds into the move, the speed changes.
      const fast = both(slow.project, slow.session, cameraMotionOps(slow.project, motion, 2.35, { clock: slow.session.cameraClock, nowMs: now }));
      const before = values(slow, now);
      const after = values(fast, now);
      before.forEach((v, i) => expect(after[i], `${motion} ${i}`).toBeCloseTo(v, 6));
      expect(detectCameraMotion(fast.project.parameters)).toEqual({ motion, speed: 2.35 });
      // The clock itself still runs in real time (the shorter periods make the move faster).
      expect(clockMs(fast.session.cameraClock, now + 1000) - clockMs(fast.session.cameraClock, now)).toBeCloseTo(1000, 6);
    }
  });

  it('a new preset starts from clock 0, at the base framing for every LFO', () => {
    const now = 1_791_457_234_694.25;
    for (const motion of CAMERA_MOTIONS) {
      if (motion === 'none') continue;
      const s0 = defaultSession(0);
      const doc = both(project(), s0, cameraMotionOps(project(), motion, 1.5, { clock: s0.cameraClock, nowMs: now }));
      expect(clockMs(doc.session.cameraClock, now), motion).toBe(0);
      for (const [id, p] of Object.entries(doc.project.parameters)) {
        if (p.modulator.kind === 'lfo') expect(evaluate(p.modulator, 0, 0, 0), `${motion} ${id}`).toBeCloseTo(0, 9);
      }
    }
  });

  it('each preset loops cleanly over cameraLoopSeconds', () => {
    const loops: Record<string, number> = { orbit: 60, 'orbit-reverse': 60, swing: 20, 'orbit-bob': 60, zoom: 16, pan: 24, tilt: 20, drift: NOISE_WINDOW_SECONDS, 'fly-around': 90 };
    for (const [motion, loop] of Object.entries(loops)) {
      for (const speed of [1, 2]) {
        const p = applyOps({ project: project() }, cameraMotionOps(project(), motion as (typeof CAMERA_MOTIONS)[number], speed)).project;
        const expected = motion === 'drift' ? loop : loop / speed;
        expect(cameraLoopSeconds(p.parameters), `${motion} @ ${speed}`).toBeCloseTo(expected, 9);
        if (motion === 'drift') continue;
        for (const param of Object.values(p.parameters)) {
          expect(evaluate(param.modulator, 0, 12_345 + expected * 1000, 0)).toBeCloseTo(evaluate(param.modulator, 0, 12_345, 0), 6);
        }
      }
    }
    const lfo = (period: number): { modulator: Modulator } => ({ modulator: { kind: 'lfo', enabled: true, shape: 'sine', period, phase: 0, amount: 1 } });
    expect(cameraLoopSeconds({})).toBe(NOISE_WINDOW_SECONDS);
    expect(cameraLoopSeconds({ 'camera.yaw': lfo(7), 'camera.pitch': lfo(3) })).toBeCloseTo(21, 9);
    expect(cameraLoopSeconds({ 'camera.yaw': lfo(7), 'camera.pitch': lfo(3.3) })).toBe(7); // no common loop: the longest
    expect(cameraLoopSeconds({ 'camera.yaw': lfo(5), 'layer.a.opacity': lfo(3) })).toBe(5); // layers don't count
  });

  it('a session saved before camera clocks reads as the wall clock (no jump)', () => {
    const { cameraClock: _, ...old } = defaultSession(123);
    const parsed = SessionSchema.parse(old);
    expect(parsed.cameraClock).toEqual(WALL_CLOCK);
    expect(clockMs(parsed.cameraClock, 1_791_457_234_694.25)).toBe(1_791_457_234_694.25);
  });

  it('a hand-edited camera modulator reads as custom', () => {
    const p = applied(project(), cameraMotionOps(project(), 'orbit', 1));
    const m = p.parameters['camera.yaw']!.modulator;
    if (m.kind === 'lfo') m.amount = 90;
    expect(detectCameraMotion(p.parameters)).toEqual({ motion: 'custom', speed: null });
  });
});
