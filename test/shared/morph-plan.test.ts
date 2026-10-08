import { describe, expect, it } from 'vitest';
import { blankInstancerLayer, blankLineLayer } from '../../src/shared/layer-schema.ts';
import {
  applyLerpPlan,
  buildLerpPlan,
  ease,
  hexFromRGB,
  lerp,
  lerpAngle,
  lerpCamera,
  lerpEffects,
  lerpHex,
  morphProgress,
  parseHex,
  type MorphCamera,
} from '../../src/shared/morph-plan.ts';
import { defaultLayerEffects, type LayerEffects } from '../../src/shared/layer-schema.ts';
import { defaultCamera } from '../../src/shared/project-schema.ts';

describe('easing and progress', () => {
  it('clamps progress to 0..1 on the wall clock', () => {
    expect(morphProgress(1000, 2000, 2)).toBe(0);
    expect(morphProgress(3000, 2000, 2)).toBe(0.5);
    expect(morphProgress(9000, 2000, 2)).toBe(1);
    expect(morphProgress(2000, 2000, 0)).toBe(1);
  });

  it('every easing is exact at the endpoints and monotonic', () => {
    for (const e of ['linear', 'smooth', 'ease-in', 'ease-out'] as const) {
      expect(ease(e, 0)).toBe(0);
      expect(ease(e, 1)).toBe(1);
      expect(ease(e, -1)).toBe(0);
      expect(ease(e, 2)).toBe(1);
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const v = ease(e, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    expect(ease('smooth', 0.5)).toBe(0.5);
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5);
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5);
  });

  it('lerp is exact at both ends even where a + (b - a) would not be', () => {
    expect(lerp(0.1, 0.3, 1)).toBe(0.3);
    expect(lerp(0.1, 0.3, 0)).toBe(0.1);
    expect(lerp(1e10, 1, 1)).toBe(1);
  });

  it('angles go the short way round and land exactly', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(360);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(0, 720, 0.5)).toBeCloseTo(0);
    expect(lerpAngle(350, 10, 1)).toBe(10);
    expect(lerpAngle(350, 10, 0)).toBe(350);
  });
});

describe('colour', () => {
  it('parses and formats hex', () => {
    expect(parseHex('#ff8000', { r: 0, g: 0, b: 0 })).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHex('#A0b0C0', { r: 0, g: 0, b: 0 })).toEqual({ r: 160, g: 176, b: 192 });
    expect(hexFromRGB(255, 128, 0)).toBe('#ff8000');
    expect(hexFromRGB(300, -5, 12.6)).toBe('#ff000d');
  });

  it('lerps in RGB with exact endpoints', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(lerpHex('#ff0000', '#0000ff', 0.5)).toBe('#800080');
    expect(lerpHex('#ABCDEF', '#000000', 1)).toBe('#000000');
  });
});

describe('lerp plan', () => {
  const from = blankInstancerLayer('a', 'A', 'd');
  from.origin = [0, 100, 0];
  from.colour = '#000000';
  from.opacity = 0.2;
  from.primitive = 'bar';
  from.arrangement = 'calendar';
  from.gridColumns = 10;
  from.channels.y.domain = null;
  from.followRange = false;
  const to = structuredClone(from);
  to.origin = [200, 300, 50];
  to.colour = '#ffffff';
  to.opacity = 0.8;
  to.arrangement = 'spiral';
  to.gridColumns = 21;
  to.channels.y.domain = [0, 10];
  to.followRange = true;
  to.name = 'B';

  it('is exactly the from config at t = 0 and the target at t = 1', () => {
    const plan = buildLerpPlan(from, to);
    expect(applyLerpPlan(plan, to, 0)).toEqual(from);
    expect(applyLerpPlan(plan, to, 1)).toEqual(to);
    // ...and back again: the plan holds no state that drifts.
    expect(applyLerpPlan(plan, to, 0)).toEqual(from);
  });

  it('lerps numbers, tuples and colours; rounds integer fields', () => {
    const plan = buildLerpPlan(from, to);
    const mid = applyLerpPlan(plan, to, 0.5);
    expect(mid.origin).toEqual([100, 200, 25]);
    expect(mid.opacity).toBeCloseTo(0.5);
    expect(mid.colour).toBe('#808080');
    expect(mid.gridColumns).toBe(16); // 15.5 rounds
    expect(Number.isInteger(applyLerpPlan(plan, to, 0.37).gridColumns)).toBe(true);
  });

  it('switches booleans, enums, strings and shape changes at 0.5', () => {
    const plan = buildLerpPlan(from, to);
    const before = applyLerpPlan(plan, to, 0.4999);
    expect(before.arrangement).toBe('calendar');
    expect(before.followRange).toBe(false);
    expect(before.name).toBe('A');
    expect(before.channels.y.domain).toBeNull();
    const after = applyLerpPlan(plan, to, 0.5);
    expect(after.arrangement).toBe('spiral');
    expect(after.followRange).toBe(true);
    expect(after.name).toBe('B');
    expect(after.channels.y.domain).toEqual([0, 10]);
  });

  it('freezes the from side and follows a changing (modulated) target', () => {
    const live = structuredClone(to);
    const fromCopy = structuredClone(from);
    const plan = buildLerpPlan(fromCopy, live);
    fromCopy.origin[0] = 9999; // mutating the source after the start changes nothing
    live.transform.rotation[2] = 90; // a modulator writes into the target each frame
    const mid = applyLerpPlan(plan, live, 0.5);
    expect(mid.origin[0]).toBe(100);
    expect(mid.transform.rotation[2]).toBe(45);
    live.transform.rotation[2] = 180;
    expect(applyLerpPlan(plan, live, 1).transform.rotation[2]).toBe(180);
  });

  it('target-only keys always take the target value', () => {
    const plan = buildLerpPlan(from, to, { targetOnly: new Set(['origin']) });
    expect(applyLerpPlan(plan, to, 0).origin).toEqual(to.origin);
    expect(applyLerpPlan(plan, to, 0).opacity).toBe(from.opacity);
  });

  it('does not touch the inputs and works across layer types', () => {
    const a = blankLineLayer('l', 'L', null);
    const b = { ...blankLineLayer('l', 'L', null), width: 10, colour: '#ff0000' };
    const snapshot = structuredClone([a, b]);
    const plan = buildLerpPlan(a, b);
    applyLerpPlan(plan, b, 0.3);
    expect([a, b]).toEqual(snapshot);
    expect(applyLerpPlan(plan, b, 0.5).width).toBe(6);
  });
});

describe('camera and effects', () => {
  const cam = (over: Partial<MorphCamera>): MorphCamera => ({ ...defaultCamera(), ...over, target: [...(over.target ?? [0, 0, 0])] });

  it('camera lerps with shortest-path yaw and exact endpoints', () => {
    const a = cam({ mode: '3d', yaw: 350, pitch: 10, distance: 2, target: [10, 0, 0] });
    const b = cam({ mode: '3d', yaw: 30, pitch: -10, distance: 1, target: [30, 0, 0] });
    const out = cam({});
    expect(lerpCamera(a, b, 0, out)).toEqual(a);
    expect(lerpCamera(a, b, 1, out)).toEqual(b);
    const mid = lerpCamera(a, b, 0.5, out);
    expect(mid.yaw).toBeCloseTo(370);
    expect(mid.pitch).toBeCloseTo(0);
    expect(mid.distance).toBeCloseTo(1.5);
    expect(mid.target[0]).toBeCloseTo(20);
  });

  it('2D <-> 3D is a continuous move from the frame-filling 3D view', () => {
    const flat = cam({ mode: '2d', yaw: 123 });
    const tilted = cam({ mode: '3d', yaw: 40, pitch: 20, distance: 3 });
    const out = cam({});
    const early = lerpCamera(flat, tilted, 0.01, out);
    expect(early.mode).toBe('3d');
    expect(early.yaw).toBeCloseTo(0.4);
    expect(early.distance).toBeCloseTo(1.02);
    const late = lerpCamera(tilted, flat, 0.99, out);
    expect(late.mode).toBe('3d');
    expect(late.pitch).toBeCloseTo(0.2);
    expect(lerpCamera(tilted, flat, 1, out)).toEqual(flat);
  });

  it('layer effects lerp numbers and fade an effect in or out instead of popping', () => {
    const off: LayerEffects = defaultLayerEffects();
    const on: LayerEffects = structuredClone(off);
    on.glow.enabled = true;
    on.glow.strength = 2;
    on.trails.enabled = true;
    on.trails.persistence = 0.9;
    const out: LayerEffects = defaultLayerEffects();
    expect(lerpEffects(off, on, 0, out)).toEqual(off);
    expect(lerpEffects(off, on, 1, out)).toEqual(on);
    const mid = lerpEffects(off, on, 0.5, out);
    expect(mid.glow.enabled).toBe(true);
    expect(mid.glow.strength).toBeCloseTo(1);
    expect(mid.trails.persistence).toBeCloseTo(0.45);
    const fading = lerpEffects(on, off, 0.75, out);
    expect(fading.glow.enabled).toBe(true);
    expect(fading.glow.strength).toBeCloseTo(0.5);
    expect(lerpEffects(on, off, 1, out)).toEqual(off);
  });
});
