import { describe, expect, it } from 'vitest';
import { layerTimeline, projectTimeline, timelineEdit } from '../../src/client/control/timeline-panel.ts';
import { blankInstancerLayer, blankTextLayer, type InstancerLayer } from '../../src/shared/layer-schema.ts';
import { paramPhase } from '../../src/shared/modulation-helpers.ts';
import type { Modulator, Parameter } from '../../src/shared/modulators.ts';
import { defaultProfile } from '../../src/shared/output-profile.ts';
import { applyOps, type PatchOp } from '../../src/shared/patch.ts';
import { defaultProject, defaultSession, ProjectSchema, type SyncDoc } from '../../src/shared/project-schema.ts';
import {
  addKeyOps,
  clockState,
  CURVE_SAMPLES,
  deleteKeyOps,
  denormalise,
  formatSeconds,
  formatTick,
  keyAtPlayheadOps,
  laneRange,
  laneValue,
  moveKeyOps,
  moveRampOps,
  normalise,
  rampAsKeyframes,
  reframeLane,
  removeLaneOps,
  removeLaneQuestion,
  tickStep,
  tidyPhase,
  tidyValue,
  timelineSummary,
  timelineView,
  waveSummary,
  waveWindow,
  type CurveLane,
  type WaveLane,
} from '../../src/shared/timeline-view.ts';

const T0 = 1_791_457_234_694; // a real wall-clock time

const param = (modulator: Modulator): Parameter => ({ modulator });
const keys = (...pairs: [number, number][]) => pairs.map(([at, value]) => ({ at, value }));

function doc(): SyncDoc {
  const p = defaultProject('t');
  p.timeline = { duration: 100, loop: true, playback: 'forward' };
  const a = blankInstancerLayer('ly-a', 'Rain', null);
  const b = blankInstancerLayer('ly-b', 'Own', null);
  b.timeline = { own: true, duration: 20, loop: true, playback: 'pingpong' };
  const c = blankTextLayer('ly-c', 'Caption', null);
  p.layers = [a, b, c];
  p.parameters = {
    // Unsorted on purpose: keyframes need not be stored in order.
    'layer.ly-a.opacity': param({ kind: 'keyframes', enabled: true, keys: keys([1, 0], [0, 1], [0.5, 0.5]), interpolation: 'linear' }),
    'layer.ly-a.rows.1': param({ kind: 'ramp', enabled: true, from: 0, to: 1, easing: 'linear' }),
    'layer.ly-a.transform.rotation.2': param({ kind: 'lfo', enabled: true, shape: 'sine', period: 4, phase: 0, amount: 20 }),
    'layer.ly-b.opacity': param({ kind: 'ramp', enabled: true, from: 1, to: 0, easing: 'smooth' }),
    'camera.yaw': param({ kind: 'noise', enabled: true, amount: 15, speed: 0.5, seed: 7 }),
  };
  const session = defaultSession(T0);
  session.layerTransports['ly-b'] = { playing: true, anchorWallMs: T0, anchorPhase: 0 };
  return { project: p, session, profile: defaultProfile('default') };
}

/** Apply ops and check the project is still valid. */
function checked(d: SyncDoc, ops: PatchOp[]): SyncDoc {
  const next = applyOps(d, ops);
  const r = ProjectSchema.safeParse(next.project);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  return next;
}

const keysOf = (d: SyncDoc, id: string) => {
  const m = d.project.parameters[id]?.modulator;
  return m?.kind === 'keyframes' ? m.keys : null;
};

describe('clockState', () => {
  const tl = { duration: 10, loop: true, playback: 'forward' as const };
  const t = { playing: true, anchorWallMs: T0, anchorPhase: 0 };

  it('follows the transport forwards, backwards and there and back', () => {
    expect(clockState(t, tl, T0 + 2500)).toMatchObject({ playhead: 0.25, progress: 0.25, direction: 1, playing: true, finished: false });
    expect(clockState(t, { ...tl, playback: 'reverse' }, T0 + 2500)).toMatchObject({ playhead: 0.75, direction: -1 });
    // Ping-pong: a 20 s cycle; out over the first 10 s, back over the next.
    const pp = { ...tl, playback: 'pingpong' as const };
    expect(clockState(t, pp, T0 + 5000)).toMatchObject({ playhead: 0.5, direction: 1 });
    const back = clockState(t, pp, T0 + 15000);
    expect(back.playhead).toBeCloseTo(0.5);
    expect(back.direction).toBe(-1);
  });

  it('reports a non-looping timeline as finished at the end', () => {
    const once = { ...tl, loop: false };
    expect(clockState(t, once, T0 + 5000).finished).toBe(false);
    expect(clockState(t, once, T0 + 50_000)).toMatchObject({ playhead: 1, finished: true });
  });

  it('writes into a reused object', () => {
    const out = clockState(t, tl, T0);
    expect(clockState(t, tl, T0 + 1000, out)).toBe(out);
    expect(out.playhead).toBeCloseTo(0.1);
  });
});

describe('timelineView', () => {
  it('lists the project clock, then layers in stack order, then the camera', () => {
    const v = timelineView(doc(), T0 + 25_000);
    expect(v.project.clock.playhead).toBeCloseTo(0.25);
    expect(v.groups.map((g) => g.key)).toEqual(['ly-a', 'ly-b', 'ly-c', 'camera']);
    expect(v.groups.map((g) => g.position)).toEqual([1, 2, 3, 0]);
    expect(v.groups[3]).toMatchObject({ kind: 'camera', name: 'Camera', own: false });
  });

  it('says which timeline drives each group, and where its playhead is', () => {
    const v = timelineView(doc(), T0 + 25_000);
    const [a, b, c] = v.groups;
    expect(a).toMatchObject({ own: false, settings: { duration: 100 } });
    expect(a!.clock.playhead).toBeCloseTo(0.25);
    // ly-b: its own 20 s ping-pong; 25 s into a 40 s cycle is on the way back, at 0.75.
    expect(b).toMatchObject({ own: true, settings: { duration: 20, playback: 'pingpong' } });
    expect(b!.clock.playhead).toBeCloseTo(0.75);
    expect(b!.clock.direction).toBe(-1);
    expect(c!.lanes).toEqual([]);
    expect(c!.free.length).toBeGreaterThan(0);
  });

  it('builds one lane per modulated parameter, in registry order', () => {
    const v = timelineView(doc(), T0);
    const a = v.groups[0]!;
    expect(a.lanes.map((l) => [l.id, l.kind])).toEqual([
      ['layer.ly-a.opacity', 'keyframes'],
      ['layer.ly-a.transform.rotation.2', 'lfo'],
      ['layer.ly-a.rows.1', 'ramp'],
    ]);
    expect(a.free.some((d) => d.id === 'layer.ly-a.opacity')).toBe(false);
    expect(a.free.some((d) => d.id === 'layer.ly-a.rows.0')).toBe(true);
    expect(v.groups[3]!.lanes.map((l) => l.kind)).toEqual(['noise']);
  });

  it('sorts keyframes and samples the curve normalised to the UI range', () => {
    const lane = timelineView(doc(), T0).groups[0]!.lanes[0] as CurveLane;
    expect(lane.keys).toEqual(keys([0, 1], [0.5, 0.5], [1, 0]));
    expect(lane.def.label).toBe('opacity');
    expect([lane.lo, lane.hi]).toEqual([0, 1]);
    expect(lane.samples).toHaveLength(CURVE_SAMPLES);
    expect(lane.samples[0]).toBeCloseTo(1);
    expect(lane.samples[CURVE_SAMPLES - 1]).toBeCloseTo(0);
    expect(lane.samples[Math.round((CURVE_SAMPLES - 1) / 4)]).toBeCloseTo(0.75, 1);
  });

  it('widens the range to include values outside the UI range', () => {
    const d = doc();
    d.project.parameters['layer.ly-a.transform.position.0'] = param({ kind: 'ramp', enabled: true, from: -5000, to: 100, easing: 'linear' });
    const lane = timelineView(d, T0).groups[0]!.lanes.find((l) => l.id === 'layer.ly-a.transform.position.0') as CurveLane;
    expect(lane.lo).toBe(-5000);
    expect(lane.hi).toBe(2000);
    expect(lane.samples[0]).toBeCloseTo(0);
    expect(lane.keys).toEqual(keys([0, -5000], [1, 100]));
  });

  it('gives ramp lanes their endpoints and the live value at the playhead', () => {
    const v = timelineView(doc(), T0 + 25_000);
    const rows = v.groups[0]!.lanes.find((l) => l.kind === 'ramp') as CurveLane;
    expect(rows.keys).toEqual(keys([0, 0], [1, 1]));
    expect(rows.value).toBeCloseTo(0.25);
    // The own-timeline layer's ramp runs on its own playhead (0.75, smooth 1 -> 0).
    const own = v.groups[1]!.lanes[0] as CurveLane;
    expect(own.value).toBeCloseTo(1 - 0.75 * 0.75 * (3 - 1.5));
  });

  it('shows LFO and noise as free-running bands around the base value', () => {
    const v = timelineView(doc(), T0);
    const lfo = v.groups[0]!.lanes[1] as WaveLane;
    expect(lfo.summary).toBe('LFO · sine · 4 s · ±20');
    expect(lfo.windowSec).toBe(8);
    expect([lfo.lo, lfo.hi]).toEqual([lfo.base - 20, lfo.base + 20]);
    expect('samples' in lfo).toBe(false);
    const noise = v.groups[3]!.lanes[0] as WaveLane;
    expect(noise.summary).toBe('Noise · 0.5/s · ±15');
    expect(noise.windowSec).toBe(12);
  });

  it('gives flat lanes some height', () => {
    const d = doc();
    d.project.parameters['layer.ly-a.transform.rotation.2'] = param({ kind: 'lfo', enabled: true, shape: 'sine', period: 4, phase: 0, amount: 0 });
    const lfo = timelineView(d, T0).groups[0]!.lanes[1]!;
    expect(lfo.hi - lfo.lo).toBeGreaterThan(0);
  });

  it('shows a switched-off modulator’s curve but the base value as its value', () => {
    const d = doc();
    d.project.parameters['layer.ly-a.rows.1'] = param({ kind: 'ramp', enabled: false, from: 0, to: 0.5, easing: 'linear' });
    (d.project.layers[0] as InstancerLayer).rows = [0, 0.9];
    const lane = timelineView(d, T0 + 50_000).groups[0]!.lanes[2] as CurveLane;
    expect(lane.enabled).toBe(false);
    expect(lane.value).toBeCloseTo(0.9);
    expect(lane.samples[CURVE_SAMPLES - 1]).toBeCloseTo(0.5);
  });
});

describe('laneValue, normalise', () => {
  it('evaluates a lane like the output, clamped to the valid range', () => {
    const lane = timelineView(doc(), T0).groups[0]!.lanes[0]!;
    expect(laneValue(lane, T0, 0.25)).toBeCloseTo(0.75);
    const lfo = timelineView(doc(), T0).groups[0]!.lanes[1]!;
    const quarter = T0 - (T0 % 4000) + 1000; // a quarter of the way through a 4 s sine
    expect(laneValue(lfo, quarter, 0)).toBeCloseTo(lfo.base + 20);
  });

  it('maps values to lane height and back', () => {
    const r = { lo: -10, hi: 30 };
    expect(normalise(r, 0)).toBeCloseTo(0.25);
    expect(denormalise(r, 0.25)).toBeCloseTo(0);
  });
});

describe('editing keys', () => {
  const id = 'layer.ly-a.opacity';

  it('moves a key in time and value, tracking its new index', () => {
    const d = doc();
    const e = moveKeyOps(d.project, id, 0, 0.75, 0.3)!;
    const next = checked(d, e.ops);
    expect(keysOf(next, id)).toEqual(keys([0.5, 0.5], [0.75, 0.3], [1, 0]));
    expect(e.index).toBe(1);
  });

  it('clamps a moved key to 0..1 and the valid range', () => {
    const d = doc();
    const next = checked(d, moveKeyOps(d.project, id, 1, -3, 7)!.ops);
    expect(keysOf(next, id)![0]).toEqual({ at: 0, value: 1 });
  });

  it('rounds keys of whole-number parameters', () => {
    const d = doc();
    d.project.parameters['layer.ly-a.cloner.count'] = param({ kind: 'keyframes', enabled: true, keys: keys([0, 1]), interpolation: 'step' });
    const next = checked(d, moveKeyOps(d.project, 'layer.ly-a.cloner.count', 0, 0.2, 4.6)!.ops);
    expect(keysOf(next, 'layer.ly-a.cloner.count')).toEqual(keys([0.2, 5]));
  });

  it('refuses keys it cannot move', () => {
    const d = doc();
    expect(moveKeyOps(d.project, id, 9, 0, 0)).toBeNull();
    expect(moveKeyOps(d.project, 'layer.ly-a.rows.1', 0, 0, 0)).toBeNull(); // a ramp
    expect(moveKeyOps(d.project, 'layer.ly-a.missing', 0, 0, 0)).toBeNull();
  });

  it('adds a key with the curve’s current value, so nothing changes', () => {
    const d = doc();
    const e = addKeyOps(d.project, id, 0.25)!;
    const next = checked(d, e.ops);
    expect(keysOf(next, id)).toEqual(keys([0, 1], [0.25, 0.75], [0.5, 0.5], [1, 0]));
    expect(e.index).toBe(1);
    // A key already there: selected, nothing sent.
    expect(addKeyOps(next.project, id, 0.25)).toEqual({ ops: [], index: 1 });
  });

  it('turns a ramp into keyframes with the same curve when a key is added', () => {
    const d = doc();
    const id = 'layer.ly-b.opacity';
    const before = timelineView(d, T0).groups[1]!.lanes[0] as CurveLane;
    // Converted alone, the curve is identical (smooth easing = smooth interpolation).
    const ramp = d.project.parameters[id]!.modulator;
    if (ramp.kind !== 'ramp') throw new Error('expected a ramp');
    const converted = checked(d, [{ op: 'set', path: ['project', 'parameters', id], value: param(rampAsKeyframes(ramp)) }]);
    const same = timelineView(converted, T0).groups[1]!.lanes[0] as CurveLane;
    for (let i = 0; i < CURVE_SAMPLES; i++) expect(same.samples[i]).toBeCloseTo(before.samples[i]!, 5);
    // With the new key, the curve still passes through the value it had there.
    const next = checked(d, addKeyOps(d.project, id, 0.25)!.ops);
    expect(next.project.parameters[id]!.modulator).toMatchObject({ kind: 'keyframes', interpolation: 'smooth' });
    expect(keysOf(next, id)![1]!.value).toBeCloseTo(1 - 0.25 * 0.25 * (3 - 0.5));
    expect(rampAsKeyframes({ kind: 'ramp', enabled: false, from: 2, to: 3, easing: 'linear' })).toEqual({
      kind: 'keyframes',
      enabled: false,
      keys: keys([0, 2], [1, 3]),
      interpolation: 'linear',
    });
  });

  it('does not add keys to LFO or noise lanes, or past 64 keys', () => {
    const d = doc();
    expect(addKeyOps(d.project, 'layer.ly-a.transform.rotation.2', 0.5)).toBeNull();
    expect(addKeyOps(d.project, 'camera.yaw', 0.5)).toBeNull();
    const many = keys(...Array.from({ length: 64 }, (_, i): [number, number] => [i / 64, 0]));
    d.project.parameters[id] = param({ kind: 'keyframes', enabled: true, keys: many, interpolation: 'linear' });
    expect(addKeyOps(d.project, id, 0.999)).toBeNull();
  });

  it('deletes keys, but never the last one', () => {
    let d = doc();
    d = checked(d, deleteKeyOps(d.project, id, 1)!);
    expect(keysOf(d, id)).toEqual(keys([0, 1], [1, 0]));
    d = checked(d, deleteKeyOps(d.project, id, 0)!);
    expect(keysOf(d, id)).toEqual(keys([1, 0]));
    expect(deleteKeyOps(d.project, id, 0)).toBeNull();
    expect(deleteKeyOps(d.project, id, 5)).toBeNull();
    expect(deleteKeyOps(d.project, 'layer.ly-a.rows.1', 0)).toBeNull();
  });

  it('moves ramp endpoints, clamped', () => {
    const d = doc();
    const next = checked(d, [...moveRampOps(d.project, 'layer.ly-a.rows.1', 'from', 0.2)!]);
    expect(next.project.parameters['layer.ly-a.rows.1']!.modulator).toMatchObject({ from: 0.2, to: 1 });
    const clamped = checked(next, moveRampOps(next.project, 'layer.ly-a.rows.1', 'to', 4)!);
    expect(clamped.project.parameters['layer.ly-a.rows.1']!.modulator).toMatchObject({ to: 1 });
    expect(moveRampOps(d.project, id, 'from', 0)).toBeNull();
  });

  it('removes a lane', () => {
    const d = doc();
    const next = checked(d, removeLaneOps(id));
    expect(next.project.parameters[id]).toBeUndefined();
  });
});

describe('key at playhead', () => {
  it('creates keyframes with one key at the playhead and the base value', () => {
    const d = doc();
    d.project.layers[0]!.transform.position[0] = 120;
    const id = 'layer.ly-a.transform.position.0';
    const e = keyAtPlayheadOps(d, id, T0 + 40_000)!;
    const next = checked(d, e.ops);
    expect(next.project.parameters[id]!.modulator).toEqual({ kind: 'keyframes', enabled: true, keys: keys([0.4, 120]), interpolation: 'linear' });
    expect(e.index).toBe(0);
  });

  it('uses the layer’s own timeline', () => {
    const d = doc();
    const id = 'layer.ly-b.transform.position.1';
    const now = T0 + 5_000; // a quarter of the way out on ly-b's 20 s ping-pong
    expect(paramPhase(d.project, d.session, id, now)).toBeCloseTo(0.25);
    const next = checked(d, keyAtPlayheadOps(d, id, now)!.ops);
    expect(keysOf(next, id)![0]!.at).toBeCloseTo(0.25);
  });

  it('adds to existing keyframes with the curve’s value', () => {
    const d = doc();
    const id = 'layer.ly-a.opacity';
    const next = checked(d, keyAtPlayheadOps(d, id, T0 + 75_000)!.ops);
    expect(keysOf(next, id)).toEqual(keys([0, 1], [0.5, 0.5], [0.75, 0.25], [1, 0]));
  });

  it('turns a ramp into keyframes', () => {
    const d = doc();
    const next = checked(d, keyAtPlayheadOps(d, 'layer.ly-a.rows.1', T0 + 30_000)!.ops);
    expect(keysOf(next, 'layer.ly-a.rows.1')!.map((k) => k.at)).toEqual([0, 0.3, 1]);
  });

  it('refuses LFO, noise and unknown parameters', () => {
    const d = doc();
    expect(keyAtPlayheadOps(d, 'camera.yaw', T0)).toBeNull();
    expect(keyAtPlayheadOps(d, 'layer.ly-a.transform.rotation.2', T0)).toBeNull();
    expect(keyAtPlayheadOps(d, 'layer.gone.opacity', T0)).toBeNull();
  });

  it('keys the camera on the project timeline', () => {
    const d = doc();
    const next = checked(d, keyAtPlayheadOps(d, 'camera.pitch', T0 + 10_000)!.ops);
    expect(keysOf(next, 'camera.pitch')).toEqual(keys([0.1, 0]));
  });
});

describe('display helpers', () => {
  it('formats seconds, timelines and waves', () => {
    expect(formatSeconds(4)).toBe('4 s');
    expect(formatSeconds(0.5)).toBe('0.5 s');
    expect(formatSeconds(150)).toBe('2:30');
    expect(timelineSummary({ duration: 20, loop: true, playback: 'pingpong' })).toBe('0:20 · ping-pong');
    expect(timelineSummary({ duration: 600, loop: false, playback: 'reverse' })).toBe('10:00 · reverse · once');
    expect(waveSummary({ kind: 'lfo', enabled: true, shape: 'square', period: 90, phase: 0, amount: -3 })).toBe('LFO · square · 1:30 · ±3');
    expect(waveWindow({ kind: 'noise', enabled: true, amount: 1, speed: 0.0001, seed: 1 })).toBe(600);
  });

  it('picks ruler steps that keep labels apart', () => {
    expect(tickStep(600, 600)).toBe(120); // 1 px a second: 64 px needs 2 min
    expect(tickStep(10, 800)).toBe(1);
    expect(tickStep(1, 800)).toBe(0.1);
    expect(tickStep(86400 * 10, 100)).toBe(86400);
    expect(formatTick(2.5, 0.5, 10)).toBe('2.5 s');
    expect(formatTick(90, 30, 600)).toBe('1:30');
    expect(formatTick(90, 30, 3600)).toBe('0:01:30');
  });
});

describe('dragging helpers', () => {
  it('rounds dragged phases and values to sensible precision', () => {
    expect(tidyPhase(0.39999995340827765)).toBe(0.4);
    expect(tidyValue(0.6000002906436012, 1)).toBe(0.6);
    expect(tidyValue(123.456, 4000)).toBe(123);
    expect(tidyValue(12.3456, 200)).toBe(12.3);
    expect(tidyValue(7, 0)).toBe(7);
  });

  it('keeps a lane’s scale fixed while a key is dragged', () => {
    const d = doc();
    d.project.parameters['layer.ly-a.transform.position.0'] = param({ kind: 'ramp', enabled: true, from: -5000, to: 100, easing: 'linear' });
    const lane = timelineView(d, T0).groups[0]!.lanes.find((l) => l.id === 'layer.ly-a.transform.position.0') as CurveLane;
    const value = denormalise(lane, lane.samples[64]!);
    reframeLane(lane, -6000, 3000);
    expect([lane.lo, lane.hi]).toEqual([-6000, 3000]);
    expect(denormalise(lane, lane.samples[64]!)).toBeCloseTo(value, 2);
    expect(lane.samples[0]).toBeCloseTo(1000 / 9000, 5);
  });
});

describe('lane scale', () => {
  const X = 'layer.ly-a.transform.position.0'; // move x: slider -2000..2000, no hard limits
  const fitted = (d: SyncDoc, id: string) => timelineView(d, T0, CURVE_SAMPLES, 'fit').groups[0]!.lanes.find((l) => l.id === id) as CurveLane;

  it('fits a lane to its values with some padding', () => {
    const d = doc();
    d.project.parameters[X] = param({ kind: 'ramp', enabled: true, from: 100, to: 900, easing: 'linear' });
    const lane = fitted(d, X);
    expect(lane.lo).toBeCloseTo(20);
    expect(lane.hi).toBeCloseTo(980);
    expect(lane.samples[0]).toBeCloseTo(80 / 960);
    expect(lane.samples[CURVE_SAMPLES - 1]).toBeCloseTo(880 / 960);
    // The slider scale squashes the same ramp into a fifth of the lane.
    const slider = timelineView(d, T0).groups[0]!.lanes.find((l) => l.id === X) as CurveLane;
    expect([slider.lo, slider.hi]).toEqual([-2000, 2000]);
  });

  it('shows small moves on a wide range, but not narrower than 2% of the slider range', () => {
    const d = doc();
    d.project.parameters[X] = param({ kind: 'keyframes', enabled: true, keys: keys([0, 0], [1, 50]), interpolation: 'linear' });
    const lane = fitted(d, X);
    // 50 apart; the minimum span is 2% of 4000 = 80, centred on the values.
    expect(lane.lo).toBeCloseTo(-15);
    expect(lane.hi).toBeCloseTo(65);
  });

  it('keeps a flat lane flat and centred', () => {
    const d = doc();
    d.project.parameters[X] = param({ kind: 'keyframes', enabled: true, keys: keys([0.5, 500]), interpolation: 'linear' });
    const lane = fitted(d, X);
    expect([lane.lo, lane.hi]).toEqual([460, 540]);
    expect(lane.samples[0]).toBeCloseTo(0.5);
  });

  it('stays inside the valid range, growing the other way when clipped', () => {
    const d = doc();
    // opacity: valid 0..1; keys 0, 0.5 and 1 fill it exactly (padding would only go outside).
    const full = fitted(d, 'layer.ly-a.opacity');
    expect([full.lo, full.hi]).toEqual([0, 1]);
    d.project.parameters['layer.ly-a.opacity'] = param({ kind: 'ramp', enabled: true, from: 0, to: 0.5, easing: 'linear' });
    const half = fitted(d, 'layer.ly-a.opacity');
    expect(half.lo).toBe(0);
    expect(half.hi).toBeCloseTo(0.55);
    d.project.parameters['layer.ly-a.opacity'] = param({ kind: 'ramp', enabled: true, from: 0, to: 0, easing: 'linear' });
    const flat = fitted(d, 'layer.ly-a.opacity');
    expect(flat.lo).toBe(0);
    expect(flat.hi).toBeCloseTo(0.02);
  });

  it('gives whole-number parameters at least 2 of height, and falls back to the slider range', () => {
    const def = { id: 'x', label: 'x', group: 'g', min: 0, max: 10, hardMin: 0, hardMax: 10, integer: true };
    expect(laneRange(def, 5, 5, 'fit')).toEqual({ lo: 4, hi: 6 });
    expect(laneRange(def, 5, 5, 'slider')).toEqual({ lo: 0, hi: 10 });
    expect(laneRange(def, 3, 20, 'slider')).toEqual({ lo: 0, hi: 20 });
    expect(laneRange(def, Infinity, -Infinity, 'fit')).toEqual({ lo: 0, hi: 10 });
  });

  it('rounds a fitted range outwards to tidy numbers', () => {
    const def = { id: 'r', label: 'rotate y', group: 'g', min: -360, max: 360, hardMin: -1e9, hardMax: 1e9, integer: false };
    // -150.3..341.2 padded by 49.15 each side is -199.45..390.35: shown as -200..400.
    expect(laneRange(def, -150.3, 341.2, 'fit')).toEqual({ lo: -200, hi: 400 });
    const unit = { ...def, min: 0, max: 1, hardMin: 0, hardMax: 1 };
    // 0.123..0.4567 padded is 0.0896..0.4901; rounded outwards in steps of 0.01: 0.08..0.5.
    expect(laneRange(unit, 0.123, 0.4567, 'fit')).toEqual({ lo: 0.08, hi: 0.5 });
  });

  it('leaves LFO and noise lanes alone (they already show their own band)', () => {
    const a = timelineView(doc(), T0).groups[0]!.lanes[1]!;
    const b = timelineView(doc(), T0, CURVE_SAMPLES, 'fit').groups[0]!.lanes[1]!;
    expect([b.lo, b.hi]).toEqual([a.lo, a.hi]);
  });
});

describe('own timeline edits', () => {
  it('re-anchors the transport so a change of duration or playback does not move the playhead', () => {
    const d = doc();
    const now = T0 + 5_000; // ly-b: 5 s into its 20 s ping-pong, playhead 0.25 on the way out
    const target = layerTimeline('ly-b');
    const before = paramPhase(d.project, d.session, 'layer.ly-b.opacity', now);
    expect(before).toBeCloseTo(0.25);
    const longer = timelineEdit(d, target, target.transport(d), { duration: 60 }, now)!;
    const d2 = checked(d, longer.ops);
    expect(d2.project.layers[1]!.timeline).toMatchObject({ own: true, duration: 60 });
    expect(d2.session.layerTransports['ly-b']).toEqual(longer.next);
    expect(paramPhase(d2.project, d2.session, 'layer.ly-b.opacity', now)).toBeCloseTo(before);
    const reverse = timelineEdit(d2, target, target.transport(d2), { playback: 'reverse', loop: false }, now)!;
    const d3 = checked(d2, reverse.ops);
    expect(d3.project.layers[1]!.timeline).toMatchObject({ playback: 'reverse', loop: false });
    expect(paramPhase(d3.project, d3.session, 'layer.ly-b.opacity', now)).toBeCloseTo(before);
  });

  it('sends nothing when nothing changes or the layer follows the project', () => {
    const d = doc();
    const target = layerTimeline('ly-b');
    expect(timelineEdit(d, target, target.transport(d), { duration: 20, playback: 'pingpong' }, T0)).toBeNull();
    const a = layerTimeline('ly-a');
    expect(timelineEdit(d, a, a.transport(d), { duration: 5 }, T0)).toBeNull();
    // The project timeline goes through the same path.
    expect(timelineEdit(d, projectTimeline, d.session.transport, { loop: false }, T0)?.ops[0]).toEqual({ op: 'set', path: ['project', 'timeline', 'loop'], value: false });
  });
});

describe('removing a lane', () => {
  it('asks with the parameter, the modulator kind and the owner', () => {
    const [a, , , cam] = timelineView(doc(), T0).groups;
    expect(removeLaneQuestion(a!.lanes[0]!, a!.name)).toBe('Remove the 3 keyframes on “opacity” (Rain)? The parameter goes back to its base value.');
    expect(removeLaneQuestion(a!.lanes[1]!, a!.name)).toMatch(/^Remove the LFO on “rotate z” \(Rain\)\?/);
    expect(removeLaneQuestion(a!.lanes[2]!, a!.name)).toMatch(/^Remove the ramp on “rows end” \(Rain\)\?/);
    expect(removeLaneQuestion(cam!.lanes[0]!, cam!.name)).toMatch(/^Remove the noise on “yaw” \(Camera\)\?/);
  });
});
