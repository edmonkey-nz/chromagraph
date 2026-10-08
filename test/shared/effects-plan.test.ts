import { describe, expect, it } from 'vitest';
import { anyEffect, emptyFxLayer, emptyPlan, MAX_TRAIL_LAYERS, planEffects, type FxLayer } from '../../src/shared/effects-plan.ts';

const layer = (over: Partial<FxLayer> = {}): FxLayer => ({ ...emptyFxLayer(), ...over });
const glow = (strength = 1, threshold = 0.2): Partial<FxLayer> => ({ glow: true, strength, radius: 0.4, threshold });
const trails = (persistence = 0.9): Partial<FxLayer> => ({ trails: true, persistence });
const plan = (layers: FxLayer[]) => planEffects(layers, layers.length, emptyPlan());

describe('planEffects', () => {
  it('nothing on: no passes', () => {
    const p = plan([layer(), layer()]);
    expect(p.whole).toBe(-1);
    expect(p.trailCount).toBe(0);
    expect(p.glowGroupCount).toBe(0);
    expect(anyEffect([layer()], 1)).toBe(false);
  });

  it('every layer with the same settings: the whole-image chain, no extra passes', () => {
    const p = plan([layer({ ...glow(), ...trails() }), layer({ ...glow(), ...trails() })]);
    expect(p.whole).toBe(0);
    expect(p.trailCount).toBe(0);
    expect(p.glowGroupCount).toBe(0);
  });

  it('settings of an effect that is off do not matter', () => {
    const a = layer({ ...glow(), persistence: 0.5 });
    const b = layer({ ...glow(), persistence: 0.7 });
    expect(plan([a, b]).whole).toBe(0);
  });

  it('trail layers each get their own history; glow-only layers group by settings', () => {
    const p = plan([layer({ ...glow(), ...trails(0.9) }), layer(glow(1)), layer(glow(2)), layer(glow(1)), layer(), layer(trails(0.5))]);
    expect(p.whole).toBe(-1);
    expect(p.trails.slice(0, p.trailCount)).toEqual([0, 5]);
    expect(p.glowGroupCount).toBe(2);
    expect(p.glowGroup.slice(0, 6)).toEqual([-1, 0, 1, 0, -1, -1]);
    expect(p.glowLead.slice(0, 2)).toEqual([1, 2]);
  });

  it('caps trail layers; the extras still glow', () => {
    const many = Array.from({ length: MAX_TRAIL_LAYERS + 2 }, (_, i) => layer({ ...trails(0.5 + i * 0.01), ...glow() }));
    const p = plan(many);
    expect(p.trailCount).toBe(MAX_TRAIL_LAYERS);
    expect(p.trailOverflow).toBe(2);
    expect(p.glowGroupCount).toBe(1);
  });

  it('reuses the plan object without stale entries', () => {
    const out = emptyPlan();
    planEffects([layer(trails()), layer(glow())], 2, out);
    planEffects([layer({ ...glow(), ...trails() })], 1, out);
    expect(out.whole).toBe(0);
    expect(out.trailCount).toBe(0);
    expect(out.glowGroupCount).toBe(0);
  });
});
