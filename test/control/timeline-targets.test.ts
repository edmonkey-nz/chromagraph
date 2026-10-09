import { describe, expect, it } from 'vitest';
import { layerTimeline, ownTimelineOps, projectTimeline } from '../../src/client/control/timeline-panel.ts';
import { blankInstancerLayer } from '../../src/shared/layer-schema.ts';
import { layerPhase, paramPhase } from '../../src/shared/modulation-helpers.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, defaultSession, ProjectSchema, SessionSchema, type SyncDoc } from '../../src/shared/project-schema.ts';
import { defaultProfile } from '../../src/shared/output-profile.ts';

const T0 = 1_791_457_234_694; // a real wall-clock time

function doc(): SyncDoc {
  const p = defaultProject('t');
  p.timeline = { duration: 100, loop: true, playback: 'forward' };
  p.layers = [blankInstancerLayer('ly-a', 'A', null), blankInstancerLayer('ly-b', 'B', null)];
  return { project: p, session: defaultSession(T0), profile: defaultProfile('default') };
}

function checked(d: SyncDoc, ops: Parameters<typeof applyOps>[1]): SyncDoc {
  const next = applyOps(d, ops);
  expect(ProjectSchema.safeParse(next.project).success).toBe(true);
  expect(SessionSchema.safeParse(next.session).success).toBe(true);
  return next;
}

describe('per-layer timelines', () => {
  it('a layer follows the project timeline until it has its own', () => {
    const d = doc();
    const at = T0 + 25_000; // 25 s into a 100 s timeline
    expect(layerPhase(d.project, d.session, 'ly-a', at)).toBeCloseTo(0.25);
    expect(paramPhase(d.project, d.session, 'layer.ly-a.opacity', at)).toBeCloseTo(0.25);
    expect(paramPhase(d.project, d.session, 'camera.yaw', at)).toBeCloseTo(0.25);
  });

  it('switching to its own timeline continues from the project position, then runs on its own', () => {
    const now = T0 + 25_000;
    const d = checked(doc(), ownTimelineOps(doc(), 'ly-a', true, now));
    expect(d.project.layers[0]!.timeline).toEqual({ own: true, duration: 100, loop: true, playback: 'forward' });
    expect(layerPhase(d.project, d.session, 'ly-a', now)).toBeCloseTo(0.25); // no jump
    // A shorter duration of its own: it now runs 10x faster than the project's.
    const short = checked(d, layerTimeline('ly-a').timelineOps(d, { duration: 10 }));
    expect(layerPhase(short.project, short.session, 'ly-a', now + 5_000)).toBeCloseTo((0.25 * 10 + 5) / 10 % 1);
    expect(layerPhase(short.project, short.session, 'ly-b', now + 5_000)).toBeCloseTo(0.3);
    // Off again: back on the project timeline, and its transport is removed.
    const off = checked(short, ownTimelineOps(short, 'ly-a', false, now));
    expect(off.session.layerTransports['ly-a']).toBeUndefined();
    expect(layerPhase(off.project, off.session, 'ly-a', now)).toBeCloseTo(0.25);
  });

  it('a layer with its own timeline but no transport yet plays with the project transport', () => {
    const d = doc();
    d.project.layers[0]!.timeline = { own: true, duration: 50, loop: true, playback: 'forward' };
    expect(layerPhase(d.project, d.session, 'ly-a', T0 + 25_000)).toBeCloseTo(0.5);
  });

  it('the project transport’s Pause and Restart also drive layers with their own timeline', () => {
    const now = T0 + 25_000;
    const d = checked(doc(), ownTimelineOps(doc(), 'ly-a', true, now));
    const paused = checked(d, projectTimeline.alsoOn!(d, 'pause', now + 1000));
    expect(paused.session.layerTransports['ly-a']!.playing).toBe(false);
    expect(Object.keys(paused.session.layerTransports)).toEqual(['ly-a']); // layer B follows the project
    const restarted = checked(paused, projectTimeline.alsoOn!(paused, 'restart', now + 2000));
    expect(layerPhase(restarted.project, restarted.session, 'ly-a', now + 2000)).toBe(0);
  });
});
