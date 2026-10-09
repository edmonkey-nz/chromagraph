import { describe, expect, it } from 'vitest';
import { layerTimeline, ownTimelineOps, playPauseEdit, projectTimeline, seekEdit, timelineEdit } from '../../src/client/control/timeline-panel.ts';
import { blankInstancerLayer } from '../../src/shared/layer-schema.ts';
import { layerPhase, paramPhase } from '../../src/shared/modulation-helpers.ts';
import { applyOps } from '../../src/shared/patch.ts';
import { defaultProject, defaultSession, ProjectSchema, SessionSchema, type SyncDoc } from '../../src/shared/project-schema.ts';
import { defaultProfile } from '../../src/shared/output-profile.ts';

const T0 = 1_791_457_234_694; // a real wall-clock time

function doc(): SyncDoc {
  const p = defaultProject('t');
  p.timeline = { ...p.timeline, duration: 100, loop: true, playback: 'forward' };
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

describe('transport edits (shared by the Timeline card and the Timeline tab)', () => {
  it('Play/Pause on the project also drives layers with their own timeline', () => {
    const now = T0 + 25_000;
    let d = checked(doc(), ownTimelineOps(doc(), 'ly-a', true, now));
    const pause = playPauseEdit(d, projectTimeline, d.session.transport, now)!;
    expect(pause.next).toEqual({ playing: false, anchorWallMs: now, anchorPhase: 0.25 });
    d = checked(d, pause.ops);
    expect(d.session.transport.playing).toBe(false);
    expect(d.session.layerTransports['ly-a']!.playing).toBe(false);
    const play = playPauseEdit(d, projectTimeline, d.session.transport, now + 1000)!;
    d = checked(d, play.ops);
    expect(d.session.transport.playing).toBe(true);
    expect(d.session.layerTransports['ly-a']!.playing).toBe(true);
  });

  it('a finished non-looping timeline plays again from the start', () => {
    const d = checked(doc(), [{ op: 'set', path: ['project', 'timeline', 'loop'], value: false }]);
    const edit = playPauseEdit(d, projectTimeline, { playing: false, anchorWallMs: T0, anchorPhase: 1 }, T0)!;
    expect(edit.next).toEqual({ playing: true, anchorWallMs: T0, anchorPhase: 0 });
  });

  it('seeks keep the ping-pong leg; Restart also restarts own timelines; a scrub does not', () => {
    const now = T0 + 25_000;
    let d = checked(doc(), ownTimelineOps(doc(), 'ly-a', true, now));
    d = checked(d, [{ op: 'set', path: ['project', 'timeline', 'playback'], value: 'pingpong' }]);
    // Three quarters through the ping-pong cycle: on the way back.
    const back = { playing: true, anchorWallMs: T0, anchorPhase: 0.75 };
    const scrub = seekEdit(d, projectTimeline, back, 0.2, T0)!;
    expect(scrub.next.anchorPhase).toBeCloseTo(0.9);
    expect(scrub.ops).toHaveLength(1);
    const restart = seekEdit(d, projectTimeline, back, 'restart', T0)!;
    expect(restart.next.anchorPhase).toBe(0);
    expect(restart.ops.map((o) => o.path.join('.'))).toEqual(['session.layerTransports.ly-a', 'session.transport']);
  });

  it('a layer following the project has nothing to play', () => {
    const d = doc();
    expect(playPauseEdit(d, layerTimeline('ly-a'), d.session.transport, T0)).toBeNull();
    expect(seekEdit(d, layerTimeline('ly-a'), d.session.transport, 0.5, T0)).toBeNull();
  });
});

describe('fades and gap before restart (project timeline only)', () => {
  const gapDoc = (): SyncDoc => {
    const d = doc();
    d.project.timeline = { ...d.project.timeline, duration: 10, gap: 2 };
    return d;
  };

  it('setting the gap, fades or fade length patches the project timeline and keeps the playhead', () => {
    const d = gapDoc();
    const now = T0 + 5_000; // halfway through the pass
    for (const change of [{ gap: 4 }, { fadeIn: true }, { fadeOut: true }, { fadeLength: 3 }]) {
      const edit = timelineEdit(d, projectTimeline, d.session.transport, change, now)!;
      const key = Object.keys(change)[0]!;
      expect(edit.ops.map((o) => o.path.join('.'))).toEqual([`project.timeline.${key}`, 'session.transport']);
      const next = checked(d, edit.ops);
      expect(layerPhase(next.project, next.session, 'ly-a', now)).toBeCloseTo(0.5);
    }
    expect(timelineEdit(d, projectTimeline, d.session.transport, { gap: 2 }, now)).toBeNull(); // unchanged
  });

  it('a layer’s own timeline ignores fades and gap', () => {
    const now = T0 + 5_000;
    const d = checked(gapDoc(), ownTimelineOps(gapDoc(), 'ly-a', true, now));
    expect(timelineEdit(d, layerTimeline('ly-a'), d.session.transport, { gap: 3, fadeIn: true }, now)).toBeNull();
    const edit = timelineEdit(d, layerTimeline('ly-a'), d.session.transport, { gap: 3, duration: 20 }, now)!;
    expect(edit.ops.map((o) => o.path.join('.'))).toEqual(['project.layers.0.timeline.duration', 'session.layerTransports.ly-a']);
    checked(d, edit.ops);
  });

  it('a scrub lands in the pass; pausing in the gap keeps the time held there', () => {
    const d = gapDoc();
    const inGap = T0 + 11_000;
    const scrub = seekEdit(d, projectTimeline, d.session.transport, 0.3, inGap)!;
    const after = checked(d, scrub.ops);
    expect(layerPhase(after.project, after.session, 'ly-b', inGap)).toBeCloseTo(0.3);
    expect(layerPhase(after.project, after.session, 'ly-b', inGap + 7_000)).toBe(1); // the gap follows the pass
    const pause = playPauseEdit(d, projectTimeline, d.session.transport, inGap)!;
    const play = playPauseEdit(checked(d, pause.ops), projectTimeline, pause.next, inGap + 60_000)!;
    const playing = checked(d, play.ops);
    expect(layerPhase(playing.project, playing.session, 'ly-b', inGap + 60_900)).toBe(1);
    expect(layerPhase(playing.project, playing.session, 'ly-b', inGap + 61_500)).toBeCloseTo(0.05);
  });
});
