import { describe, expect, it } from 'vitest';
import { blankInstancerLayer, blankLineLayer } from '../../src/shared/layer-schema.ts';
import { applyOps } from '../../src/shared/patch.ts';
import {
  defaultProject,
  defaultSession,
  MorphSchema,
  ProjectSchema,
  SceneSchema,
  SessionSchema,
  type Project,
  type SyncDoc,
} from '../../src/shared/project-schema.ts';
import { defaultProfile } from '../../src/shared/output-profile.ts';
import {
  addSceneOps,
  captureScene,
  deleteSceneOps,
  goToSceneOps,
  jsonEqual,
  missingSceneDatasets,
  morphProgress,
  moveSceneOps,
  neighbourScene,
  newSceneId,
  nextSceneName,
  renameSceneOps,
  replacesProjectBranch,
  sceneMatches,
  sceneTransition,
  setSceneTransitionOps,
  updateSceneOps,
} from '../../src/shared/scene-helpers.ts';

function project(): Project {
  const p = defaultProject('t');
  p.datasets = [{ id: 'ds', file: 'rain.csv', label: 'Rain', timeZone: 'Pacific/Auckland' }];
  p.layers = [blankInstancerLayer('ly-a', 'Points', 'ds'), blankLineLayer('ly-b', 'Line', 'ds')];
  p.parameters = { 'camera.yaw': { modulator: { kind: 'ramp', enabled: true, from: 0, to: 90, easing: 'linear' } } };
  p.output.background = '#101010';
  p.output.effects.bloom.enabled = true;
  return ProjectSchema.parse(p);
}

function doc(p: Project): SyncDoc {
  return { project: p, session: defaultSession(0), profile: defaultProfile('default') };
}

/** Apply ops and check the whole document still validates. */
function applyChecked(d: SyncDoc, ops: Parameters<typeof applyOps>[1]): SyncDoc {
  const next = applyOps(d, ops);
  expect(ProjectSchema.safeParse(next.project).success).toBe(true);
  expect(SessionSchema.safeParse(next.session).success).toBe(true);
  return next;
}

describe('captureScene', () => {
  it('produces a valid scene that copies, never shares, the project', () => {
    const p = project();
    const s = captureScene(p, 'sc-1', 'Opening');
    expect(SceneSchema.safeParse(s).success).toBe(true);
    expect(s.layers).toEqual(p.layers);
    expect(s.layers).not.toBe(p.layers);
    expect(s.layers[0]).not.toBe(p.layers[0]);
    expect(s.camera).not.toBe(p.camera);
    expect(s.output).toEqual({ background: '#101010', effects: p.output.effects });
    expect(s.output.effects).not.toBe(p.output.effects);
    expect(s.parameters).toEqual(p.parameters);
    expect(s.transition).toBeNull();
    expect(sceneMatches(p, s)).toBe(true);
  });

  it('keeps an optional transition', () => {
    const s = captureScene(project(), 'sc-1', 'A', { duration: 4, easing: 'ease-in' });
    expect(SceneSchema.parse(s).transition).toEqual({ duration: 4, easing: 'ease-in' });
  });
});

describe('scene list ops', () => {
  it('adds, renames, updates, moves and deletes scenes, keeping the project valid', () => {
    let d = doc(project());
    d = applyChecked(d, addSceneOps(d.project, 'sc-a', 'A'));
    d = applyChecked(d, addSceneOps(d.project, 'sc-b', 'B'));
    expect(d.project.scenes.map((s) => s.id)).toEqual(['sc-a', 'sc-b']);

    d = applyChecked(d, renameSceneOps(d.project, 'sc-a', 'Alpha')!);
    expect(d.project.scenes[0]!.name).toBe('Alpha');

    d = applyChecked(d, moveSceneOps(d.project, 'sc-a', 1)!);
    expect(d.project.scenes.map((s) => s.id)).toEqual(['sc-b', 'sc-a']);
    expect(moveSceneOps(d.project, 'sc-b', -1)).toBeNull();
    expect(moveSceneOps(d.project, 'sc-a', 1)).toBeNull();

    // Change the project, then update a scene from it: id, name and transition stay.
    d = applyChecked(d, setSceneTransitionOps(d.project, 'sc-a', { duration: 0.5, easing: 'linear' })!);
    d = applyChecked(d, [{ op: 'set', path: ['project', 'camera', 'yaw'], value: 30 }]);
    expect(sceneMatches(d.project, d.project.scenes[1]!)).toBe(false);
    d = applyChecked(d, updateSceneOps(d.project, 'sc-a')!);
    const a = d.project.scenes[1]!;
    expect(a).toMatchObject({ id: 'sc-a', name: 'Alpha', transition: { duration: 0.5, easing: 'linear' } });
    expect(a.camera.yaw).toBe(30);
    expect(sceneMatches(d.project, a)).toBe(true);

    d = applyChecked(d, setSceneTransitionOps(d.project, 'sc-a', null)!);
    expect(d.project.scenes[1]!.transition).toBeNull();

    d = applyChecked(d, deleteSceneOps(d.project, 'sc-b')!);
    expect(d.project.scenes.map((s) => s.id)).toEqual(['sc-a']);
  });

  it('returns null for unknown scenes', () => {
    const p = project();
    expect(goToSceneOps(p, 'nope', 0)).toBeNull();
    expect(updateSceneOps(p, 'nope')).toBeNull();
    expect(renameSceneOps(p, 'nope', 'x')).toBeNull();
    expect(deleteSceneOps(p, 'nope')).toBeNull();
    expect(moveSceneOps(p, 'nope', 1)).toBeNull();
    expect(setSceneTransitionOps(p, 'nope', null)).toBeNull();
  });
});

describe('goToSceneOps', () => {
  it('is one patch that copies the scene in and starts a morph', () => {
    let d = doc(project());
    d = applyChecked(d, addSceneOps(d.project, 'sc-a', 'A'));
    const captured = d.project.scenes[0]!;
    // Change everything a scene covers.
    d = applyChecked(d, [
      { op: 'set', path: ['project', 'layers'], value: [] },
      { op: 'set', path: ['project', 'camera', 'mode'], value: '3d' },
      { op: 'set', path: ['project', 'output', 'background'], value: '#ffffff' },
      { op: 'set', path: ['project', 'parameters'], value: {} },
    ]);
    const ops = goToSceneOps(d.project, 'sc-a', 12_345)!;
    expect(ops.map((o) => o.path.join('.'))).toEqual(['project.layers', 'project.camera', 'project.output', 'project.parameters', 'session.morph']);
    d = applyChecked(d, ops);
    expect(sceneMatches(d.project, captured)).toBe(true);
    expect(d.project.layers).not.toBe(captured.layers);
    expect(MorphSchema.parse(d.session.morph)).toEqual({ startWallMs: 12_345, duration: 2, easing: 'smooth', sceneId: 'sc-a' });
    expect(replacesProjectBranch(ops)).toBe(true);
  });

  it("uses the scene's own transition over the project's", () => {
    let d = doc(project());
    d = applyChecked(d, [{ op: 'set', path: ['project', 'transition'], value: { duration: 7, easing: 'ease-out' } }]);
    d = applyChecked(d, addSceneOps(d.project, 'sc-a', 'A'));
    expect(sceneTransition(d.project, d.project.scenes[0]!)).toEqual({ duration: 7, easing: 'ease-out' });
    d = applyChecked(d, setSceneTransitionOps(d.project, 'sc-a', { duration: 0.1, easing: 'linear' })!);
    d = applyChecked(d, goToSceneOps(d.project, 'sc-a', 0)!);
    expect(d.session.morph).toMatchObject({ duration: 0.1, easing: 'linear' });
  });
});

describe('small helpers', () => {
  it('makes unique ids and names', () => {
    const p = project();
    p.scenes = [captureScene(p, 'sc-00000000', 'Scene 1')];
    let calls = 0;
    const id = newSceneId(p, () => (calls++ === 0 ? 0 : 0.5));
    expect(id).not.toBe('sc-00000000');
    expect(id).toMatch(/^sc-[0-9a-z]{8}$/);
    expect(nextSceneName(p)).toBe('Scene 2');
    p.scenes.push(captureScene(p, 'sc-x', 'Scene 2'));
    expect(nextSceneName(p)).toBe('Scene 3');
  });

  it('finds neighbours, wrapping', () => {
    const p = project();
    expect(neighbourScene(p, null, 1)).toBeNull();
    p.scenes = ['a', 'b', 'c'].map((id) => captureScene(p, id, id));
    expect(neighbourScene(p, null, 1)?.id).toBe('a');
    expect(neighbourScene(p, null, -1)?.id).toBe('c');
    expect(neighbourScene(p, 'a', -1)?.id).toBe('c');
    expect(neighbourScene(p, 'c', 1)?.id).toBe('a');
    expect(neighbourScene(p, 'b', 1)?.id).toBe('c');
    expect(neighbourScene(p, 'gone', 1)?.id).toBe('a');
  });

  it('compares JSON structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(jsonEqual(NaN, NaN)).toBe(true);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it('reports datasets a scene needs that have gone', () => {
    const p = project();
    const s = captureScene(p, 's', 's');
    expect(missingSceneDatasets(p, s)).toEqual([]);
    expect(missingSceneDatasets({ datasets: [] }, s)).toEqual(['ds']);
  });

  it('spots patches that replace whole project branches', () => {
    expect(replacesProjectBranch([{ op: 'set', path: ['project', 'layers', 0, 'name'], value: 'x' }])).toBe(false);
    expect(replacesProjectBranch([{ op: 'set', path: ['project', 'scenes'], value: [] }])).toBe(false);
    expect(replacesProjectBranch([{ op: 'set', path: ['session', 'morph'], value: null }])).toBe(false);
    expect(replacesProjectBranch([{ op: 'set', path: ['project', 'camera'], value: {} }])).toBe(true);
  });

  it('measures morph progress', () => {
    expect(morphProgress(null, 5)).toBe(1);
    const m = { startWallMs: 1000, duration: 2 };
    expect(morphProgress(m, 0)).toBe(0);
    expect(morphProgress(m, 2000)).toBe(0.5);
    expect(morphProgress(m, 9000)).toBe(1);
  });
});
