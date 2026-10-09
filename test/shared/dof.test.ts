import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Stage } from '../../src/client/output/stage.ts';
import { blurAt, DOF_MIN_RAMP, dofShows, focusDistance, viewDistance } from '../../src/shared/dof.ts';
import { lerpDof } from '../../src/shared/morph-plan.ts';
import { defaultCamera, defaultDof, migrate, type Camera } from '../../src/shared/project-schema.ts';
import v12 from '../fixtures/projects/v12.json' with { type: 'json' };

const cam3d = (over: Partial<Camera> = {}): Camera => ({ ...defaultCamera(), mode: '3d', dof: { ...defaultDof(), enabled: true }, ...over });

describe('depth of field maths', () => {
  it('keeps the focus zone sharp and ramps to the full blur', () => {
    const dof = { depth: 200, amount: 12 };
    expect(blurAt(1000, 1000, dof)).toBe(0);
    expect(blurAt(1100, 1000, dof)).toBe(0); // edge of the sharp zone
    expect(blurAt(900, 1000, dof)).toBe(0);
    expect(blurAt(1200, 1000, dof)).toBeCloseTo(6); // half way up the 200 px ramp
    expect(blurAt(800, 1000, dof)).toBeCloseTo(6); // in front as well as behind
    expect(blurAt(1300, 1000, dof)).toBe(12);
    expect(blurAt(99_999, 1000, dof)).toBe(12);
  });

  it('never ramps over less than the minimum', () => {
    expect(blurAt(1000 + DOF_MIN_RAMP / 2, 1000, { depth: 0, amount: 10 })).toBeCloseTo(5);
  });

  it('focuses on the camera target, moved by focus', () => {
    const c = cam3d({ distance: 1.5, dof: { ...defaultDof(), enabled: true, focus: -200 } });
    const fake = { perspectiveCamera: new PerspectiveCamera(), isometricCamera: new OrthographicCamera(), camera: null as unknown };
    Stage.prototype.setCamera.call(fake as unknown as Stage, c);
    const eye = fake.perspectiveCamera.position;
    const target = new Vector3(960, 540, 0);
    expect(focusDistance(c)).toBeCloseTo(eye.distanceTo(target) - 200, 6);
    expect(focusDistance(cam3d({ dof: { ...defaultDof(), focus: -1e6 } }))).toBe(0);
  });

  it('reads view distances back from depth, in both projections', () => {
    const persp = new PerspectiveCamera(45, 16 / 9, 5, 30_000);
    const ortho = new OrthographicCamera(-960, 960, 540, -540, -800, 4000);
    for (const cam of [persp, ortho]) {
      cam.position.set(0, 0, 0);
      cam.lookAt(0, 0, -1);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      for (const d of [10, 400, 1234, 3999]) {
        const ndc = new Vector3(30, -20, -d).project(cam);
        const depth = ndc.z * 0.5 + 0.5;
        expect(viewDistance(depth, cam.near, cam.far, cam === ortho)).toBeCloseTo(d, 2);
      }
    }
  });

  it('shows only with a 3D camera, switched on, and enough blur', () => {
    expect(dofShows(cam3d(), 1)).toBe(true);
    expect(dofShows(cam3d({ mode: '2d' }), 1)).toBe(false);
    expect(dofShows(cam3d({ dof: { ...defaultDof(), enabled: false } }), 1)).toBe(false);
    expect(dofShows(cam3d({ dof: { ...defaultDof(), enabled: true, amount: 0.6 } }), 1)).toBe(true);
    expect(dofShows(cam3d({ dof: { ...defaultDof(), enabled: true, amount: 0.6 } }), 0.5)).toBe(false);
  });
});

describe('depth of field in morphs and migrations', () => {
  const on = { enabled: true, focus: 100, depth: 300, amount: 20 };
  const off = { enabled: false, focus: -500, depth: 50, amount: 4 };

  it('is exact at the ends', () => {
    expect(lerpDof(on, off, 0, defaultDof())).toEqual(on);
    expect(lerpDof(on, off, 1, defaultDof())).toEqual(off);
  });

  it('fades in and out instead of popping, at the focus of the side that has it', () => {
    expect(lerpDof(off, on, 0.25, defaultDof())).toEqual({ enabled: true, focus: 100, depth: 300, amount: 5 });
    expect(lerpDof(on, off, 0.25, defaultDof())).toEqual({ enabled: true, focus: 100, depth: 300, amount: 15 });
    expect(lerpDof(off, { ...off, focus: 0 }, 0.5, defaultDof()).enabled).toBe(false);
  });

  it('lerps between two cameras with it on', () => {
    const b = { enabled: true, focus: 300, depth: 100, amount: 10 };
    expect(lerpDof(on, b, 0.5, defaultDof())).toEqual({ enabled: true, focus: 200, depth: 200, amount: 15 });
  });

  it('adds it (off) to v12 cameras and scenes', () => {
    const r = migrate(v12);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.camera.dof).toEqual(defaultDof());
    for (const scene of r.project.scenes) expect(scene.camera.dof).toEqual(defaultDof());
  });
});
