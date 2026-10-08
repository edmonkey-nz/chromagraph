import { describe, expect, it } from 'vitest';
import {
  cameraPatch,
  GIZMO_MODES,
  gizmoModeForKey,
  LatestThrottle,
  parsePreviewMessage,
  snapFor,
  snapLabel,
  transformPatch,
  type Clock,
} from '../../src/shared/editor-helpers.ts';
import { blankTextLayer, identityTransform, blankLineLayer } from '../../src/shared/layer-schema.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, ProjectSchema, type Project } from '../../src/shared/project-schema.ts';

function project(): Project {
  return { ...defaultProject('t'), layers: [blankLineLayer('ly-a', 'A', null), blankTextLayer('ly-b', 'B', null)] };
}

describe('snap and keys', () => {
  it('maps levels to per-mode snap values, off = 0', () => {
    for (const m of GIZMO_MODES) expect(snapFor(m, 'off')).toBe(0);
    expect(snapFor('translate', 'small')).toBe(10);
    expect(snapFor('rotate', 'large')).toBe(15);
    expect(snapFor('scale', 'small')).toBe(0.05);
    expect(snapLabel('translate', 'large')).toBe('50 px');
    expect(snapLabel('rotate', 'small')).toBe('5°');
    expect(snapLabel('scale', 'off')).toBe('off');
  });

  it('reads W/E/R in either case', () => {
    expect(gizmoModeForKey('w')).toBe('translate');
    expect(gizmoModeForKey('E')).toBe('rotate');
    expect(gizmoModeForKey('r')).toBe('scale');
    expect(gizmoModeForKey('q')).toBeNull();
  });
});

describe('parsePreviewMessage', () => {
  it('accepts the four message kinds', () => {
    expect(parsePreviewMessage({ t: 'ready' })).toEqual({ t: 'ready' });
    expect(parsePreviewMessage({ t: 'select', layerId: null })).toEqual({ t: 'select', layerId: null });
    expect(parsePreviewMessage({ t: 'select', layerId: 'x' })).toEqual({ t: 'select', layerId: 'x' });
    const tr = identityTransform();
    expect(parsePreviewMessage({ t: 'transform', layerId: 'x', transform: tr, final: true })).toEqual({ t: 'transform', layerId: 'x', transform: tr, final: true });
    expect(parsePreviewMessage({ t: 'camera', camera: { a: 1 } })).toMatchObject({ t: 'camera', final: false });
  });

  it('rejects anything else', () => {
    for (const bad of [null, 1, 'ready', {}, { t: 'edit' }, { t: 'select', layerId: 3 }, { t: 'transform', layerId: 'x' }, { t: 'camera', camera: null }]) {
      expect(parsePreviewMessage(bad)).toBeNull();
    }
  });
});

describe('patches from the preview', () => {
  it('sets a layer transform by id, validated', () => {
    const p = project();
    const t = { ...identityTransform(), position: [10, 20, 0] as [number, number, number] };
    const ops = transformPatch(p, 'ly-b', t);
    expect(ops).toEqual([{ op: 'set', path: ['project', 'layers', 1, 'transform'], value: t }]);
    const next = applyOps({ project: p }, ops!).project;
    expect(ProjectSchema.safeParse(next).success).toBe(true);
  });

  it('drops invalid, unknown-layer and no-op transforms', () => {
    const p = project();
    expect(transformPatch(p, 'ly-a', identityTransform())).toBeNull();
    expect(transformPatch(p, 'nope', { ...identityTransform(), position: [1, 0, 0] })).toBeNull();
    expect(transformPatch(p, 'ly-a', { ...identityTransform(), position: [Number.NaN, 0, 0] })).toBeNull();
    expect(transformPatch(p, 'ly-a', { position: [1, 2, 3] })).toBeNull();
    expect(transformPatch(p, 'ly-a', 'x')).toBeNull();
  });

  it('sets the camera when valid and changed', () => {
    const p = project();
    const cam = { ...p.camera, mode: '3d' as const, yaw: 30 };
    expect(cameraPatch(p, cam)).toEqual([{ op: 'set', path: ['project', 'camera'], value: cam }]);
    expect(cameraPatch(p, p.camera)).toBeNull();
    expect(cameraPatch(p, { ...cam, pitch: 120 })).toBeNull();
    expect(cameraPatch(p, { ...cam, distance: 0 })).toBeNull();
  });
});

describe('LatestThrottle', () => {
  function fakeClock() {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const clock: Clock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    return { clock, advance, pending: () => timers.length };
  }

  it('sends the first value at once and then the latest once per interval', () => {
    const { clock, advance } = fakeClock();
    const out: number[] = [];
    const th = new LatestThrottle<number>(33, (v) => out.push(v), clock);
    th.push(1);
    advance(5);
    th.push(2);
    advance(5);
    th.push(3);
    expect(out).toEqual([1]);
    advance(30);
    expect(out).toEqual([1, 3]);
    advance(100);
    expect(out).toEqual([1, 3]);
    th.push(4);
    expect(out).toEqual([1, 3, 4]);
  });

  it('sends a final value at once and drops what was waiting', () => {
    const { clock, advance, pending } = fakeClock();
    const out: number[] = [];
    const th = new LatestThrottle<number>(33, (v) => out.push(v), clock);
    th.push(1);
    th.push(2);
    th.push(3, true);
    expect(out).toEqual([1, 3]);
    expect(pending()).toBe(0);
    advance(100);
    expect(out).toEqual([1, 3]);
  });

  it('flush sends what is waiting; cancel drops it', () => {
    const { clock } = fakeClock();
    const out: number[] = [];
    const th = new LatestThrottle<number>(33, (v) => out.push(v), clock);
    th.push(1);
    th.push(2);
    th.flush();
    expect(out).toEqual([1, 2]);
    th.flush();
    expect(out).toEqual([1, 2]);
    th.push(3);
    th.cancel();
    th.flush();
    expect(out).toEqual([1, 2]);
  });
});
