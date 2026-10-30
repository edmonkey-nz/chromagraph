import { describe, expect, it } from 'vitest';
import { easeToward, flightPose, followGoal, followPathOps, ROAD_VIEW, type FlightPose, type V3 } from '../../src/shared/camera-follow.ts';
import { blankLineLayer } from '../../src/shared/layer-schema.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { readReveal } from '../../src/shared/reveal.ts';
import { defaultProject, ProjectSchema } from '../../src/shared/project-schema.ts';
import { orbitFromCamera } from '../../src/shared/editor-maths.ts';
import { CameraSchema, defaultCamera } from '../../src/shared/project-schema.ts';

describe('follow camera', () => {
  it('the goal is the tip plus lead, its height between a flat road and the tip', () => {
    const out: V3 = [0, 0, 0];
    const base = { target: [0, -100, 0] as [number, number, number] }; // flat road at y = 440
    expect(followGoal([1000, 640, 5], base, { height: 0, lead: 50 }, out)).toEqual([1050, 440, 5]);
    expect(followGoal([1000, 640, 5], base, { height: 1, lead: 0 }, out)).toEqual([1000, 640, 5]);
    expect(followGoal([1000, 640, 5], base, { height: 0.5, lead: 0 }, out)[1]).toBe(540);
  });

  it('easing is frame-rate independent and 0 s snaps', () => {
    const goal = [100, 0, 0];
    const once: V3 = [0, 0, 0];
    easeToward(once, goal, 1 / 30, 0.5);
    const twice: V3 = [0, 0, 0];
    easeToward(twice, goal, 1 / 60, 0.5);
    easeToward(twice, goal, 1 / 60, 0.5);
    expect(twice[0]).toBeCloseTo(once[0], 9);
    // After `seconds`, about 63 % of the way.
    const s: V3 = [0, 0, 0];
    for (let i = 0; i < 60; i++) easeToward(s, goal, 1 / 60, 1);
    expect(s[0]).toBeCloseTo(100 * (1 - Math.exp(-1)), 6);
    expect(easeToward([0, 0, 0], goal, 0.01, 0)).toEqual([100, 0, 0]);
  });

  it('road view puts the eye behind the point (smaller x), a little above and to the side', () => {
    const cam = { ...defaultCamera(), mode: '3d' as const, ...ROAD_VIEW };
    const { position, target } = orbitFromCamera(cam);
    expect(position[0]).toBeLessThan(target[0]);
    expect(position[1]).toBeGreaterThan(target[1]);
    // Off to the side, so the chart is not seen edge on, but mostly behind.
    expect(position[2]).toBeGreaterThan(target[2]);
    expect(target[0] - position[0]).toBeGreaterThan(position[2] - target[2]);
  });

  it('cameras get an off follow setting; the schema needs it', () => {
    expect(defaultCamera().follow.enabled).toBe(false);
    const { follow: _f, ...noFollow } = defaultCamera();
    expect(CameraSchema.safeParse(noFollow).success).toBe(false);
  });
});

describe('loop flight', () => {
  const pose: FlightPose = { mix: 0, yaw: 0, pitch: 0, distanceScale: 1 };

  it('starts and lands on the plain follow view', () => {
    expect(flightPose(0, 1, pose)).toEqual({ mix: 0, yaw: 0, pitch: 0, distanceScale: 1 });
    const end = flightPose(1, 2, pose);
    expect(end.mix).toBe(1);
    expect(end.yaw).toBe(720); // whole turns: the same view
    expect(end.pitch).toBeCloseTo(0, 9);
    expect(end.distanceScale).toBeCloseTo(1, 9);
  });

  it('circles, rises and pulls out most at the middle; eased at both ends', () => {
    const mid = flightPose(0.5, 1, { ...pose });
    expect(mid.yaw).toBe(180);
    expect(mid.pitch).toBeCloseTo(25, 9);
    expect(mid.distanceScale).toBeCloseTo(1.8, 9);
    expect(flightPose(0.05, 1, pose).mix).toBeLessThan(0.05);
    expect(flightPose(2, 1, pose).mix).toBe(1); // clamped
  });
});

describe('follow path', () => {
  function project() {
    const p = defaultProject('t');
    p.layers = [{ ...blankLineLayer('ly-a', 'Rain', 'ds'), colour: '#ffffff', width: 4, rows: [0.1, 0.9] }];
    p.output = { ...p.output, background: '#000000' };
    return p;
  }

  it('dims the line as the path, adds a copy that builds up over it, and follows the copy in 3D', () => {
    const p = project();
    const next = applyOps({ project: p }, followPathOps(p, 'ly-a', 'ly-b')).project;
    expect(ProjectSchema.safeParse(next).success).toBe(true);
    const [path, copy] = next.layers;
    expect(path!.type === 'line' && path!.colour).toBe('#666666');
    expect(copy!.name).toBe('Rain · follow path');
    expect(copy!.type === 'line' && copy!.width).toBe(5);
    expect(readReveal(next, path!)!.mode).toBe('off');
    const r = readReveal(next, copy!)!;
    expect([r.mode, r.start, r.end, r.from]).toEqual(['build', 0.1, 0.9, 0.1]);
    expect(next.camera.follow).toMatchObject({ enabled: true, layerId: 'ly-b' });
    expect(next.camera).toMatchObject({ mode: '3d', yaw: ROAD_VIEW.yaw });
  });

  it('only for line layers', () => {
    expect(followPathOps(project(), 'nope', 'x')).toEqual([]);
  });
});
