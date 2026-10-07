import { describe, expect, it } from 'vitest';
import { blankInstancerLayer, type InstancerLayer } from '../../src/shared/layer-schema.ts';
import {
  addKeyframe,
  clampDuration,
  dataPlayheadOps,
  defaultModulator,
  formatClock,
  formatPosition,
  layerParamCopyOps,
  layerParamRemovalOps,
  modulatedValue,
  orphanParamIds,
  paramTitle,
  reanchor,
  removeKeyframe,
} from '../../src/shared/modulation-helpers.ts';
import { MODULATOR_KINDS, ModulatorSchema, timelinePhase, type Parameter } from '../../src/shared/modulators.ts';
import { parameterDefs } from '../../src/shared/parameters.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, ProjectSchema, type Project } from '../../src/shared/project-schema.ts';

const ramp = (from: number, to: number): Parameter => ({ modulator: { kind: 'ramp', enabled: true, from, to, easing: 'linear' } });

function project(): Project {
  const p = defaultProject('t');
  const a = blankInstancerLayer('ly-a', 'Rain', 'ds');
  a.rows = [0.25, 0.75];
  const b = blankInstancerLayer('ly-b', 'Other', 'ds');
  return {
    ...p,
    layers: [a, b],
    parameters: {
      'layer.ly-a.opacity': ramp(0, 1),
      'layer.ly-a.rows.1': ramp(0, 1),
      'layer.ly-b.opacity': ramp(1, 0),
      'camera.yaw': ramp(-10, 10),
    },
  };
}

describe('timeline formatting', () => {
  it('formats clocks with hours only when the total needs them', () => {
    expect(formatClock(205)).toBe('3:25');
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(205, 3600)).toBe('0:03:25');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(-1)).toBe('0:00');
    expect(formatPosition(205 / 600, 600)).toBe('3:25 / 10:00');
    expect(formatPosition(0.5, 7200)).toBe('1:00:00 / 2:00:00');
  });

  it('clamps durations to 1 s .. 24 h', () => {
    expect(clampDuration(0)).toBe(1);
    expect(clampDuration(90)).toBe(90);
    expect(clampDuration(1e9)).toBe(86400);
    expect(clampDuration(Number.NaN)).toBe(1);
  });

  it('re-anchors the transport so a duration change keeps the playhead where it is', () => {
    const t = { playing: true, anchorWallMs: 0, anchorPhase: 0 };
    const now = 30_000;
    const r = reanchor(t, { duration: 60, loop: true }, now);
    expect(r).toEqual({ playing: true, anchorWallMs: now, anchorPhase: 0.5 });
    // Under the new duration the phase carries on from 0.5.
    expect(timelinePhase(r, 600, true, now)).toBe(0.5);
    expect(timelinePhase(r, 600, true, now + 60_000)).toBeCloseTo(0.6);
  });
});

describe('modulator defaults', () => {
  const def = { min: 0, max: 200, hardMin: 0, hardMax: 1e9, integer: false };

  it('produces a valid modulator of every kind', () => {
    for (const kind of MODULATOR_KINDS) {
      const m = defaultModulator(kind, def, 50, 7);
      expect(m.kind).toBe(kind);
      expect(ModulatorSchema.safeParse(m).success, kind).toBe(true);
    }
  });

  it('scales to the parameter range and starts from the base value', () => {
    expect(defaultModulator('lfo', def, 50)).toMatchObject({ shape: 'sine', period: 4, amount: 20 });
    expect(defaultModulator('noise', def, 50, 3)).toMatchObject({ amount: 20, speed: 0.5, seed: 3 });
    expect(defaultModulator('ramp', def, 50)).toMatchObject({ from: 50, to: 200 });
    expect(defaultModulator('keyframes', def, 50)).toMatchObject({ keys: [{ at: 0, value: 50 }, { at: 1, value: 50 }] });
    const seed = (defaultModulator('noise', def, 0) as { seed: number }).seed;
    expect(Number.isInteger(seed)).toBe(true);
  });

  it('evaluates and clamps like the output, sorting keyframes first', () => {
    const keys = defaultModulator('keyframes', def, 0);
    if (keys.kind !== 'keyframes') throw new Error('kind');
    keys.keys = [
      { at: 1, value: 100 },
      { at: 0, value: 0 },
    ];
    expect(modulatedValue(def, keys, 0, 0, 0.5)).toBe(50);
    expect(modulatedValue(def, defaultModulator('ramp', def, -50), 0, 0, 0)).toBe(0);
    expect(modulatedValue({ ...def, integer: true }, { kind: 'ramp', enabled: true, from: 0, to: 3, easing: 'linear' }, 0, 0, 0.5)).toBe(2);
  });
});

describe('keyframe editing', () => {
  it('adds a key in the widest gap at the current curve value', () => {
    const k = addKeyframe([
      { at: 0, value: 0 },
      { at: 1, value: 10 },
    ]);
    expect(k).toEqual([
      { at: 0, value: 0 },
      { at: 0.5, value: 5 },
      { at: 1, value: 10 },
    ]);
    expect(addKeyframe([{ at: 0, value: 3 }])).toEqual([
      { at: 0, value: 3 },
      { at: 0.5, value: 3 },
    ]);
  });

  it('keeps between 1 and 64 keys', () => {
    let keys = [{ at: 0, value: 0 }];
    for (let i = 0; i < 100; i++) keys = addKeyframe(keys);
    expect(keys).toHaveLength(64);
    expect(removeKeyframe([{ at: 0, value: 1 }], 0)).toEqual([{ at: 0, value: 1 }]);
    expect(
      removeKeyframe(
        [
          { at: 0, value: 1 },
          { at: 1, value: 2 },
        ],
        0,
      ),
    ).toEqual([{ at: 1, value: 2 }]);
  });
});

describe('layer patches', () => {
  it('removes only the deleted layer’s modulators', () => {
    const p = project();
    const ops = layerParamRemovalOps(p.parameters, 'ly-a');
    expect(ops).toEqual([
      { op: 'remove', path: ['project', 'parameters', 'layer.ly-a.opacity'] },
      { op: 'remove', path: ['project', 'parameters', 'layer.ly-a.rows.1'] },
    ]);
    const next = applyOps({ project: p }, [{ op: 'remove', path: ['project', 'layers', 0] }, ...ops]).project;
    expect(Object.keys(next.parameters).sort()).toEqual(['camera.yaw', 'layer.ly-b.opacity']);
  });

  it('copies modulators to a duplicated layer id', () => {
    const p = project();
    const ops = layerParamCopyOps(p.parameters, 'ly-a', 'ly-c');
    expect(ops.map((o) => o.path[2])).toEqual(['layer.ly-c.opacity', 'layer.ly-c.rows.1']);
    const next = applyOps({ project: p }, ops).project;
    expect(next.parameters['layer.ly-c.rows.1']).toEqual(p.parameters['layer.ly-a.rows.1']);
    expect(next.parameters['layer.ly-c.rows.1']).not.toBe(p.parameters['layer.ly-a.rows.1']);
  });

  it('does not treat a layer id that is a prefix of another as the same layer', () => {
    const p = project();
    p.parameters['layer.ly-ab.opacity'] = ramp(0, 1);
    expect(layerParamRemovalOps(p.parameters, 'ly-a').map((o) => o.path[2])).not.toContain('layer.ly-ab.opacity');
  });

  it('finds orphaned parameters', () => {
    const p = project();
    p.parameters['layer.gone.opacity'] = ramp(0, 1);
    p.parameters['layer.ly-a.channels.y.range.0'] = ramp(0, 1); // channel not mapped
    expect(orphanParamIds(p, parameterDefs(p)).sort()).toEqual(['layer.gone.opacity', 'layer.ly-a.channels.y.range.0']);
  });
});

describe('data playhead', () => {
  it('reveal ramps rows end and resets rows start to a plain 0', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.0'] = ramp(0.5, 0.5);
    const ops = dataPlayheadOps(p, 'ly-a', 'reveal');
    expect(ops).not.toBeNull();
    const next = applyOps({ project: p }, ops!).project;
    expect(next.parameters['layer.ly-a.rows.1']).toEqual(ramp(0, 1));
    expect(next.parameters['layer.ly-a.rows.0']).toBeUndefined();
    expect((next.layers[0] as InstancerLayer).rows).toEqual([0, 0.75]);
    expect(ProjectSchema.safeParse(next).success).toBe(true);
  });

  it('window sweeps a window of width w', () => {
    const p = project();
    const next = applyOps({ project: p }, dataPlayheadOps(p, 'ly-b', 'window', 0.25)!).project;
    expect(next.parameters['layer.ly-b.rows.1']).toEqual(ramp(0, 1));
    expect(next.parameters['layer.ly-b.rows.0']).toEqual(ramp(-0.25, 0.75));
    expect(ProjectSchema.safeParse(next).success).toBe(true);
    // Width is clamped to 0.01..1.
    const tiny = applyOps({ project: p }, dataPlayheadOps(p, 'ly-b', 'window', 0)!).project;
    expect(tiny.parameters['layer.ly-b.rows.0']).toEqual(ramp(-0.01, 0.99));
  });

  it('returns null for a missing layer', () => {
    expect(dataPlayheadOps(project(), 'nope', 'reveal')).toBeNull();
  });
});

describe('labels', () => {
  it('titles a parameter as "Group · label"', () => {
    expect(paramTitle({ group: 'Camera', label: 'yaw' })).toBe('Camera · yaw');
  });
});
