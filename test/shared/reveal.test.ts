import { describe, expect, it } from 'vitest';
import {
  blankHeatmapLayer,
  blankHierarchyLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankMultiplesLayer,
  blankReflectorLayer,
  blankSurfaceLayer,
  blankTextLayer,
  type InstancerLayer,
} from '../../src/shared/layer-schema.ts';
import { orphanParamIds } from '../../src/shared/modulation-helpers.ts';
import type { Parameter } from '../../src/shared/modulators.ts';
import { parameterDefs } from '../../src/shared/parameters.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, ProjectSchema, type Project } from '../../src/shared/project-schema.ts';
import { animateKind, followOps, readFollow, readReveal, revealOps, rowsSpan, type Reveal } from '../../src/shared/reveal.ts';

const ramp = (from: number, to: number, easing: 'linear' | 'smooth' = 'linear'): Parameter => ({
  modulator: { kind: 'ramp', enabled: true, from, to, easing },
});

function project(): Project {
  const p = defaultProject('t');
  const a = blankInstancerLayer('ly-a', 'Rain', 'ds');
  a.rows = [0.25, 0.75];
  return { ...p, layers: [a, blankInstancerLayer('ly-b', 'Other', 'ds')] };
}

const layerOf = (p: Project, id: string) => p.layers.find((l) => l.id === id)!;
const reveal = (p: Project, id: string) => readReveal(p, layerOf(p, id))!;
const apply = (p: Project, id: string, r: Reveal): Project => {
  const next = applyOps({ project: p }, revealOps(p, id, r)).project;
  expect(ProjectSchema.safeParse(next).success).toBe(true);
  return next;
};

describe('reveal: reading a layer’s row animation', () => {
  it('reads plain rows as off, over the visible range', () => {
    expect(reveal(project(), 'ly-a')).toMatchObject({ mode: 'off', start: 0.25, end: 0.75 });
  });

  it('reads a ramp on rows end as build up, from the ramp’s start to its end', () => {
    // As the old data playhead made it: rows end ramps 0 -> 1 whatever the base range.
    const p = project();
    p.parameters['layer.ly-a.rows.1'] = ramp(0, 1, 'smooth');
    expect(reveal(p, 'ly-a')).toMatchObject({ mode: 'build', start: 0, end: 1, from: 0, easing: 'smooth' });
  });

  it('reads a reveal that starts part way (Blocks: rows 0..0.917 show, then the rest arrive)', () => {
    const p = project();
    (p.layers[0] as InstancerLayer).rows = [0, 0.917];
    p.parameters['layer.ly-a.rows.1'] = ramp(0.917, 1);
    const r = reveal(p, 'ly-a');
    expect(r).toMatchObject({ mode: 'build', start: 0, end: 1, from: 0.917 });
    // Written back unchanged, apart from the base end, which becomes the end.
    const next = apply(p, 'ly-a', r);
    expect(next.parameters['layer.ly-a.rows.1']).toEqual(ramp(0.917, 1));
    expect((next.layers[0] as InstancerLayer).rows).toEqual([0, 1]);
    expect(reveal(next, 'ly-a')).toEqual(r);
  });

  it('reads two ramps a constant width apart as a window', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.1'] = ramp(0, 1);
    p.parameters['layer.ly-a.rows.0'] = ramp(-0.25, 0.75);
    expect(reveal(p, 'ly-a')).toMatchObject({ mode: 'window', start: 0, end: 1, from: 0, width: 0.25 });
  });

  it('reads anything else on the rows as custom', () => {
    const lfo: Parameter = { modulator: { kind: 'lfo', enabled: true, shape: 'sine', period: 10, phase: 0, amount: 0.1 } };
    const cases: Record<string, Parameter>[] = [
      { 'layer.ly-a.rows.1': lfo },
      { 'layer.ly-a.rows.0': ramp(0, 0.5) },
      { 'layer.ly-a.rows.1': { modulator: { ...ramp(0, 1).modulator, enabled: false } } },
      { 'layer.ly-a.rows.1': ramp(1, 0) },
      { 'layer.ly-a.rows.1': ramp(0, 1), 'layer.ly-a.rows.0': ramp(-0.1, 0.5) },
    ];
    for (const parameters of cases) {
      const p = { ...project(), parameters };
      expect(reveal(p, 'ly-a').mode).toBe('custom');
    }
  });

  it('only applies to layers with a row range', () => {
    expect(animateKind(blankTextLayer('t', 'T', 'ds'))).toBe('row');
    expect(animateKind(blankReflectorLayer('r', 'R'))).toBeNull();
    for (const l of [blankLineLayer('l', 'L', 'ds'), blankHeatmapLayer('h', 'H', 'ds'), blankMultiplesLayer('m', 'M', 'ds'), blankHierarchyLayer('x', 'X', 'ds'), blankSurfaceLayer('s', 'S', 'ds')]) {
      expect(animateKind(l)).toBe('rows');
    }
    expect(readReveal(defaultProject('t'), blankTextLayer('t', 'T', 'ds'))).toBeNull();
  });
});

describe('reveal: writing it', () => {
  it('build up ramps rows end from start to end, and keeps them as the base range', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.0'] = ramp(0.5, 0.5);
    const next = apply(p, 'ly-a', { mode: 'build', start: 0.1, end: 0.9, from: 0.1, width: 0.1, easing: 'linear' });
    expect(next.parameters['layer.ly-a.rows.1']).toEqual(ramp(0.1, 0.9));
    expect(next.parameters['layer.ly-a.rows.0']).toBeUndefined();
    expect((next.layers[0] as InstancerLayer).rows).toEqual([0.1, 0.9]);
    expect(reveal(next, 'ly-a')).toMatchObject({ mode: 'build', start: 0.1, end: 0.9 });
    // Starting part way, clamped between start and end.
    const part = apply(p, 'ly-a', { mode: 'build', start: 0.1, end: 0.9, from: 0.5, width: 0.1, easing: 'linear' });
    expect(part.parameters['layer.ly-a.rows.1']).toEqual(ramp(0.5, 0.9));
    const below = apply(p, 'ly-a', { mode: 'build', start: 0.1, end: 0.9, from: 0, width: 0.1, easing: 'linear' });
    expect(below.parameters['layer.ly-a.rows.1']).toEqual(ramp(0.1, 0.9));
  });

  it('window slides a window of width w from start to end', () => {
    const next = apply(project(), 'ly-b', { mode: 'window', start: 0, end: 1, from: 0, width: 0.25, easing: 'smooth' });
    expect(next.parameters['layer.ly-b.rows.1']).toEqual(ramp(0, 1, 'smooth'));
    expect(next.parameters['layer.ly-b.rows.0']).toEqual(ramp(-0.25, 0.75, 'smooth'));
    expect(reveal(next, 'ly-b')).toMatchObject({ mode: 'window', width: 0.25, easing: 'smooth' });
    // Width is clamped to 0.01..1.
    const tiny = apply(project(), 'ly-b', { mode: 'window', start: 0, end: 1, from: 0, width: 0, easing: 'linear' });
    expect(tiny.parameters['layer.ly-b.rows.0']).toEqual(ramp(-0.01, 0.99));
  });

  it('off removes the animation and shows the range', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.1'] = ramp(0, 1);
    p.parameters['layer.ly-a.rows.0'] = ramp(-0.1, 0.9);
    const next = apply(p, 'ly-a', { mode: 'off', start: 0, end: 0.5, from: 0, width: 0.1, easing: 'linear' });
    expect(next.parameters['layer.ly-a.rows.0']).toBeUndefined();
    expect(next.parameters['layer.ly-a.rows.1']).toBeUndefined();
    expect((next.layers[0] as InstancerLayer).rows).toEqual([0, 0.5]);
  });

  it('custom only moves the base range, leaving the modulators alone', () => {
    const p = project();
    const lfo: Parameter = { modulator: { kind: 'lfo', enabled: true, shape: 'sine', period: 10, phase: 0, amount: 0.1 } };
    p.parameters['layer.ly-a.rows.1'] = lfo;
    const next = apply(p, 'ly-a', { mode: 'custom', start: 0.2, end: 0.6, from: 0.2, width: 0.1, easing: 'linear' });
    expect(next.parameters['layer.ly-a.rows.1']).toBe(lfo);
    expect((next.layers[0] as InstancerLayer).rows).toEqual([0.2, 0.6]);
  });

  it('keeps start before end', () => {
    const next = apply(project(), 'ly-a', { mode: 'build', start: 0.8, end: 0.3, from: 0.8, width: 0.1, easing: 'linear' });
    const [s, e] = (next.layers[0] as InstancerLayer).rows;
    expect(e).toBeGreaterThan(s);
  });

  it('animates every layer type with a row range, with valid parameters', () => {
    const p = project();
    p.layers.push(blankLineLayer('ly-l', 'L', 'ds'), blankMultiplesLayer('ly-m', 'M', 'ds'), blankHierarchyLayer('ly-x', 'X', 'ds'), blankSurfaceLayer('ly-s', 'S', 'ds'), blankHeatmapLayer('ly-h', 'H', 'ds'));
    let next = p;
    for (const id of ['ly-l', 'ly-m', 'ly-x', 'ly-s', 'ly-h']) next = apply(next, id, { mode: 'window', start: 0, end: 1, from: 0, width: 0.1, easing: 'linear' });
    expect(orphanParamIds(next)).toEqual([]);
  });

  it('returns no ops for a missing layer or one without rows', () => {
    const p = project();
    p.layers.push(blankTextLayer('ly-t', 'T', 'ds'));
    const r: Reveal = { mode: 'build', start: 0, end: 1, from: 0, width: 0.1, easing: 'linear' };
    expect(revealOps(p, 'nope', r)).toEqual([]);
    expect(revealOps(p, 'ly-t', r)).toEqual([]);
  });
});

describe('follow timeline (text layers)', () => {
  it('ramps the row 0 -> 1, and removes it again', () => {
    const p = project();
    p.layers.push(blankTextLayer('ly-t', 'Caption', 'ds'));
    expect(readFollow(p, 'ly-t')).toBe(false);
    const on = applyOps({ project: p }, followOps(p, 'ly-t', true)).project;
    expect(on.parameters['layer.ly-t.row']).toEqual(ramp(0, 1));
    expect(readFollow(on, 'ly-t')).toBe(true);
    expect(ProjectSchema.safeParse(on).success).toBe(true);
    expect(parameterDefs(on).some((d) => d.id === 'layer.ly-t.row')).toBe(true);
    const off = applyOps({ project: on }, followOps(on, 'ly-t', false)).project;
    expect(off.parameters['layer.ly-t.row']).toBeUndefined();
    expect(followOps(off, 'ly-t', false)).toEqual([]);
    on.parameters['layer.ly-t.row'] = ramp(0.2, 0.4);
    expect(readFollow(on, 'ly-t')).toBe('custom');
  });
});

describe('rowsSpan', () => {
  it('is the base range without modulators', () => {
    expect(rowsSpan(project(), layerOf(project(), 'ly-a'))).toEqual([0.25, 0.75]);
  });

  it('covers every row a build up or window reaches', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.1'] = ramp(0, 1);
    expect(rowsSpan(p, layerOf(p, 'ly-a'))).toEqual([0.25, 1]);
    p.parameters['layer.ly-a.rows.0'] = ramp(-0.2, 0.8);
    expect(rowsSpan(p, layerOf(p, 'ly-a'))).toEqual([0, 1]);
  });

  it('covers LFOs, noise and keyframes, clamped to 0..1, and ignores switched-off modulators', () => {
    const p = project();
    p.parameters['layer.ly-a.rows.0'] = { modulator: { kind: 'noise', enabled: true, amount: 0.1, speed: 1, seed: 1 } };
    p.parameters['layer.ly-a.rows.1'] = {
      modulator: { kind: 'keyframes', enabled: true, interpolation: 'linear', keys: [{ at: 0, value: 0.5 }, { at: 1, value: 1.4 }] },
    };
    const [lo, hi] = rowsSpan(p, layerOf(p, 'ly-a'))!;
    expect(lo).toBeCloseTo(0.15, 9);
    expect(hi).toBe(1);
    p.parameters['layer.ly-a.rows.1'] = { modulator: { ...ramp(0, 1).modulator, enabled: false } };
    expect(rowsSpan(p, layerOf(p, 'ly-a'))![1]).toBe(0.75);
  });

  it('is null for layers without rows', () => {
    expect(rowsSpan(project(), blankTextLayer('t', 'T', 'ds'))).toBeNull();
  });
});
