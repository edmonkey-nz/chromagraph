import { Euler, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  cameraFromOrbit,
  fitDistance,
  gizmoSnap,
  ISOMETRIC_DEPTH,
  isometricHalfSize,
  orbitFromCamera,
  proxyFromTransform,
  Throttle,
  transformFromProxy,
  unwrapDegrees,
} from '../../src/shared/editor-maths.ts';
import type { LayerTransform } from '../../src/shared/layer-schema.ts';
import { defaultDof, type Camera } from '../../src/shared/project-schema.ts';
import { Stage } from '../../src/client/output/stage.ts';

const cams: Camera[] = [
  { mode: '3d', fov: 45, yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0], projection: 'perspective', dof: defaultDof() },
  { mode: '3d', fov: 30, yaw: 35, pitch: 20, distance: 1.7, target: [120, -40, 15], projection: 'perspective', dof: defaultDof() },
  { mode: '3d', fov: 90, yaw: -150, pitch: -60, distance: 0.4, target: [-300, 200, -80], projection: 'perspective', dof: defaultDof() },
  { mode: '3d', fov: 60, yaw: 179, pitch: 88, distance: 3, target: [0, 0, 500], projection: 'perspective', dof: defaultDof() },
];

function expectCameraClose(a: Camera, b: Camera): void {
  expect(a.mode).toBe(b.mode);
  expect(a.fov).toBeCloseTo(b.fov, 9);
  expect(a.yaw).toBeCloseTo(b.yaw, 3);
  expect(a.pitch).toBeCloseTo(b.pitch, 3);
  expect(a.distance).toBeCloseTo(b.distance, 5);
  a.target.forEach((v, i) => expect(v).toBeCloseTo(b.target[i]!, 2));
}

describe('camera orbit maths', () => {
  it('frame-filling distance at 45 degrees', () => {
    expect(fitDistance(45)).toBeCloseTo(540 / Math.tan(Math.PI / 8), 9);
  });

  it('matches Stage.setCamera', () => {
    for (const cfg of cams) {
      const fake = { perspectiveCamera: new PerspectiveCamera(), camera: null as unknown };
      Stage.prototype.setCamera.call(fake as unknown as Stage, cfg);
      const { position } = orbitFromCamera(cfg);
      const p = fake.perspectiveCamera.position;
      expect(p.x).toBeCloseTo(position[0], 6);
      expect(p.y).toBeCloseTo(position[1], 6);
      expect(p.z).toBeCloseTo(position[2], 6);
    }
  });

  it('round trips config -> eye/target -> config', () => {
    for (const cfg of cams) {
      const { position, target } = orbitFromCamera(cfg);
      expectCameraClose(cameraFromOrbit(position, target, cfg.fov, cfg.yaw)!, cfg);
    }
  });

  it('unwraps yaw towards the reference turn', () => {
    const cfg: Camera = { mode: '3d', fov: 45, yaw: 370, pitch: 10, distance: 1, target: [0, 0, 0], projection: 'perspective', dof: defaultDof() };
    const { position, target } = orbitFromCamera(cfg);
    expect(cameraFromOrbit(position, target, 45, 360)!.yaw).toBeCloseTo(370, 6);
    expect(cameraFromOrbit(position, target, 45, 0)!.yaw).toBeCloseTo(10, 6);
  });

  it('rounds so patches stay readable', () => {
    const { position, target } = orbitFromCamera({ mode: '3d', fov: 45, yaw: 0, pitch: 0, distance: 1.2, target: [0, 0, 0], projection: 'perspective', dof: defaultDof() });
    const cfg = cameraFromOrbit(position, target, 45)!;
    expect(cfg.distance).toBe(1.2);
    expect(cfg.pitch).toBe(0);
  });

  it('keeps the projection while orbiting', () => {
    const cfg: Camera = { mode: '3d', fov: 45, yaw: 45, pitch: 35.26, distance: 1.5, target: [0, 0, 0], projection: 'isometric', dof: defaultDof() };
    const { position, target } = orbitFromCamera(cfg);
    const back = cameraFromOrbit(position, target, cfg.fov, cfg.yaw, cfg.projection)!;
    expect(back.projection).toBe('isometric');
    expectCameraClose(back, cfg);
    expect(cameraFromOrbit(position, target, cfg.fov)!.projection).toBe('perspective');
  });

  it('keeps depth of field while orbiting, as a copy', () => {
    const dof = { enabled: true, focus: -120, depth: 300, amount: 18 };
    const cfg: Camera = { mode: '3d', fov: 45, yaw: 20, pitch: 10, distance: 1, target: [0, 0, 0], projection: 'perspective', dof };
    const { position, target } = orbitFromCamera(cfg);
    const back = cameraFromOrbit(position, target, cfg.fov, cfg.yaw, cfg.projection, dof)!;
    expect(back.dof).toEqual(dof);
    expect(back.dof).not.toBe(dof);
    expect(cameraFromOrbit(position, target, cfg.fov)!.dof.enabled).toBe(false);
  });

  it('clamps pitch to the schema and rejects a degenerate eye', () => {
    expect(cameraFromOrbit([960, 5000, 0.0001], [960, 540, 0], 45)!.pitch).toBe(89);
    expect(cameraFromOrbit([960, 540, 0], [960, 540, 0], 45)).toBeNull();
  });
});

describe('isometric camera', () => {
  const stageWith = () => ({ perspectiveCamera: new PerspectiveCamera(), isometricCamera: new OrthographicCamera(), camera: null as unknown });
  const ndc = (cam: OrthographicCamera, x: number, y: number, z: number) => new Vector3(x, y, z).project(cam);

  it('scales the view with distance', () => {
    expect(isometricHalfSize(1)).toEqual([960, 540]);
    expect(isometricHalfSize(2)).toEqual([1920, 1080]);
    expect(isometricHalfSize(0)).toEqual([960, 540]); // invalid distances fall back to 1
  });

  it('fills the frame with the z = 0 plane at yaw = pitch = 0, distance 1', () => {
    const fake = stageWith();
    Stage.prototype.setCamera.call(fake as unknown as Stage, { mode: '3d', fov: 45, yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0], projection: 'isometric', dof: defaultDof() });
    expect(fake.camera).toBe(fake.isometricCamera);
    const cam = fake.isometricCamera;
    cam.updateMatrixWorld();
    const a = ndc(cam, 0, 0, 0);
    const b = ndc(cam, 1920, 1080, 0);
    expect(a.x).toBeCloseTo(-1, 9);
    expect(a.y).toBeCloseTo(-1, 9);
    expect(b.x).toBeCloseTo(1, 9);
    expect(b.y).toBeCloseTo(1, 9);
    // Orthographic: depth does not move a point on screen.
    const c = ndc(cam, 0, 0, 800);
    expect(c.x).toBeCloseTo(-1, 9);
    expect(c.y).toBeCloseTo(-1, 9);
  });

  it('orbits like the perspective camera and keeps the scene inside near/far', () => {
    for (const base of cams) {
      const cfg: Camera = { ...base, projection: 'isometric', dof: defaultDof() };
      const fake = stageWith();
      Stage.prototype.setCamera.call(fake as unknown as Stage, cfg);
      const { position, target } = orbitFromCamera(cfg);
      const p = fake.isometricCamera.position;
      expect(p.x).toBeCloseTo(position[0], 6);
      expect(p.y).toBeCloseTo(position[1], 6);
      expect(p.z).toBeCloseTo(position[2], 6);
      const cam = fake.isometricCamera;
      cam.updateMatrixWorld();
      // The target sits mid-screen, and points far either side of it stay within the depth range.
      const t = ndc(cam, target[0], target[1], target[2]);
      expect(t.x).toBeCloseTo(0, 6);
      expect(t.y).toBeCloseTo(0, 6);
      for (const [dx, dy, dz] of [[0, 0, 5000], [0, 0, -5000], [5000, 0, 0], [0, 5000, 0]] as const) {
        const z = ndc(cam, target[0] + dx, target[1] + dy, target[2] + dz).z;
        expect(Math.abs(z)).toBeLessThan(1);
      }
      expect(cam.far - cam.near).toBeCloseTo(2 * ISOMETRIC_DEPTH, 6);
    }
  });
});

describe('unwrapDegrees', () => {
  it('keeps the angle but moves it to the nearest turn', () => {
    expect(unwrapDegrees(-10, 350)).toBe(350);
    expect(unwrapDegrees(170, -170)).toBe(-190);
    expect(unwrapDegrees(30, 0)).toBe(30);
    expect(unwrapDegrees(30, 720)).toBe(750);
  });
});

describe('gizmo proxy maths', () => {
  const t: LayerTransform = { position: [100, -50, 20], rotation: [10, -25, 350], scale: [1.5, 0.75, 2], pivot: [960, 540, 0] };

  it('round trips transform -> proxy -> transform', () => {
    const p = proxyFromTransform(t);
    expect(p.position).toEqual([1060, 490, 20]);
    expect(transformFromProxy(p.position, p.rotation, p.scale, t.pivot, t.rotation)).toEqual(t);
  });

  it('proxy * T(-pivot) reproduces the layer matrix', () => {
    const DEG = Math.PI / 180;
    // Layer matrix as layers/transform.ts builds it.
    const layer = new Matrix4()
      .compose(
        new Vector3(t.position[0] + t.pivot[0], t.position[1] + t.pivot[1], t.position[2] + t.pivot[2]),
        new Quaternion().setFromEuler(new Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ')),
        new Vector3(...t.scale),
      )
      .multiply(new Matrix4().makeTranslation(-t.pivot[0], -t.pivot[1], -t.pivot[2]));
    const p = proxyFromTransform(t);
    const proxy = new Matrix4()
      .compose(new Vector3(...p.position), new Quaternion().setFromEuler(new Euler(...p.rotation, 'XYZ')), new Vector3(...p.scale))
      .multiply(new Matrix4().makeTranslation(-t.pivot[0], -t.pivot[1], -t.pivot[2]));
    proxy.elements.forEach((v, i) => expect(v).toBeCloseTo(layer.elements[i]!, 6));
  });

  it('rounds and drops -0', () => {
    const out = transformFromProxy([960.123456, 540 - 1e-9, 0], [0, -1e-12, 0], [1.000049, 1, 1], [960, 540, 0]);
    expect(out.position).toEqual([0.12, 0, 0]);
    expect(Object.is(out.position[1], 0)).toBe(true);
    expect(Object.is(out.rotation[1], 0)).toBe(true);
    expect(out.scale).toEqual([1, 1, 1]);
  });
});

describe('gizmoSnap', () => {
  it('maps the protocol snap per mode', () => {
    expect(gizmoSnap('translate', 0)).toBeNull();
    expect(gizmoSnap('translate', 10)).toBe(10);
    expect(gizmoSnap('rotate', 15)).toBeCloseTo(Math.PI / 12, 12);
    expect(gizmoSnap('scale', 1)).toBe(0.05);
    expect(gizmoSnap('scale', 0.1)).toBe(0.1);
  });
});

describe('Throttle', () => {
  function harness() {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: number[] = [];
    const th = new Throttle<number>(
      33,
      (v) => sent.push(v),
      () => now,
      (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      (h) => timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
    );
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    };
    return { th, sent, advance };
  }

  it('sends the first value at once and the latest pending one later', () => {
    const { th, sent, advance } = harness();
    th.push(1);
    th.push(2);
    th.push(3);
    expect(sent).toEqual([1]);
    advance(40);
    expect(sent).toEqual([1, 3]);
    advance(40);
    th.push(4);
    expect(sent).toEqual([1, 3, 4]);
  });

  it('clear drops what is pending', () => {
    const { th, sent, advance } = harness();
    th.push(1);
    th.push(2);
    th.clear();
    advance(100);
    expect(sent).toEqual([1]);
    th.push(5);
    expect(sent).toEqual([1, 5]);
  });
});
