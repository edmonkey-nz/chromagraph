import type { PatchOp } from './patch.ts';
import type { Morph, Project, Scene, Transition } from './project-schema.ts';

/**
 * Pure helpers for scenes (see `project.scenes` in project-schema.ts). A scene is a named
 * copy of the project's look: layers, camera, output (background and effects) and
 * modulators. Going to a scene is ONE patch that copies those four back into the project
 * and starts a morph (`session.morph`); the output does the morphing.
 */

/** Deep copy of plain JSON data (project documents are plain JSON). */
function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Capture the project's current look as a scene. Everything is copied, never shared. */
export function captureScene(project: Project, id: string, name: string, transition: Transition | null = null): Scene {
  return {
    id,
    name,
    layers: clone(project.layers),
    camera: clone(project.camera),
    output: { background: project.output.background, effects: clone(project.output.effects) },
    parameters: clone(project.parameters),
    transition: transition ? { ...transition } : null,
  };
}

/** A scene id not used by any scene in the project. `rand` is injectable for tests. */
export function newSceneId(project: Pick<Project, 'scenes'>, rand: () => number = Math.random): string {
  const used = new Set(project.scenes.map((s) => s.id));
  for (;;) {
    const id = `sc-${Math.floor(rand() * 36 ** 8)
      .toString(36)
      .padStart(8, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** "Scene n" with the smallest n (from the scene count + 1 up) that no scene uses. */
export function nextSceneName(project: Pick<Project, 'scenes'>): string {
  const names = new Set(project.scenes.map((s) => s.name));
  let n = project.scenes.length + 1;
  while (names.has(`Scene ${n}`)) n++;
  return `Scene ${n}`;
}

export function sceneIndex(project: Pick<Project, 'scenes'>, sceneId: string): number {
  return project.scenes.findIndex((s) => s.id === sceneId);
}

/** The transition used when going to `scene`: its own, else the project's default. */
export function sceneTransition(project: Pick<Project, 'transition'>, scene: Pick<Scene, 'transition'>): Transition {
  return scene.transition ?? project.transition;
}

/** Ops that append a newly captured scene. */
export function addSceneOps(project: Project, id: string, name: string): PatchOp[] {
  return [{ op: 'set', path: ['project', 'scenes', project.scenes.length], value: captureScene(project, id, name) }];
}

/**
 * Ops that go to a scene: the project's layers, camera, output and parameters become the
 * scene's, and a morph starts at `nowMs` (wall clock). Null when the scene doesn't exist.
 */
export function goToSceneOps(project: Project, sceneId: string, nowMs: number): PatchOp[] | null {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  const t = sceneTransition(project, scene);
  const morph: Morph = { startWallMs: nowMs, duration: t.duration, easing: t.easing, sceneId };
  return [
    { op: 'set', path: ['project', 'layers'], value: clone(scene.layers) },
    { op: 'set', path: ['project', 'camera'], value: clone(scene.camera) },
    { op: 'set', path: ['project', 'output'], value: clone(scene.output) },
    { op: 'set', path: ['project', 'parameters'], value: clone(scene.parameters) },
    { op: 'set', path: ['session', 'morph'], value: morph },
  ];
}

/** Ops that overwrite a scene's look with the current project (name, id and transition kept). */
export function updateSceneOps(project: Project, sceneId: string): PatchOp[] | null {
  const i = sceneIndex(project, sceneId);
  const scene = project.scenes[i];
  if (!scene) return null;
  return [{ op: 'set', path: ['project', 'scenes', i], value: captureScene(project, scene.id, scene.name, scene.transition) }];
}

export function renameSceneOps(project: Project, sceneId: string, name: string): PatchOp[] | null {
  const i = sceneIndex(project, sceneId);
  if (i < 0) return null;
  return [{ op: 'set', path: ['project', 'scenes', i, 'name'], value: name }];
}

export function deleteSceneOps(project: Project, sceneId: string): PatchOp[] | null {
  const i = sceneIndex(project, sceneId);
  if (i < 0) return null;
  return [{ op: 'remove', path: ['project', 'scenes', i] }];
}

/** Swap a scene with its neighbour (`delta` -1 = up, 1 = down). Null at either end. */
export function moveSceneOps(project: Project, sceneId: string, delta: -1 | 1): PatchOp[] | null {
  const i = sceneIndex(project, sceneId);
  const j = i + delta;
  const a = project.scenes[i];
  const b = project.scenes[j];
  if (i < 0 || !a || !b) return null;
  return [
    { op: 'set', path: ['project', 'scenes', j], value: a },
    { op: 'set', path: ['project', 'scenes', i], value: b },
  ];
}

/** Set (or with null, clear) a scene's own transition. */
export function setSceneTransitionOps(project: Project, sceneId: string, transition: Transition | null): PatchOp[] | null {
  const i = sceneIndex(project, sceneId);
  if (i < 0) return null;
  return [{ op: 'set', path: ['project', 'scenes', i, 'transition'], value: transition ? { ...transition } : null }];
}

/**
 * The scene before or after `activeId` (wrapping). With no active scene, "next" is the
 * first and "previous" the last. Null when there are no scenes.
 */
export function neighbourScene(project: Pick<Project, 'scenes'>, activeId: string | null, delta: -1 | 1): Scene | null {
  const n = project.scenes.length;
  if (n === 0) return null;
  const i = activeId === null ? -1 : sceneIndex(project, activeId);
  if (i < 0) return project.scenes[delta === 1 ? 0 : n - 1] ?? null;
  return project.scenes[(i + delta + n) % n] ?? null;
}

/** Structural equality for plain JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && jsonEqual(ra[k], rb[k]));
}

/** True when the project currently shows exactly what the scene holds. */
export function sceneMatches(project: Project, scene: Scene): boolean {
  return (
    jsonEqual(project.layers, scene.layers) &&
    jsonEqual(project.camera, scene.camera) &&
    jsonEqual(project.output, scene.output) &&
    jsonEqual(project.parameters, scene.parameters)
  );
}

/** Dataset ids a scene's layers use that the project no longer has (they would show nothing). */
export function missingSceneDatasets(project: Pick<Project, 'datasets'>, scene: Pick<Scene, 'layers'>): string[] {
  const have = new Set(project.datasets.map((d) => d.id));
  const missing = new Set<string>();
  for (const l of scene.layers) if (l.datasetId !== null && !have.has(l.datasetId)) missing.add(l.datasetId);
  return [...missing];
}

/**
 * True when a patch replaces a whole top-level branch of the project (layers, camera,
 * output, parameters, or the project itself), as going to a scene does. A control window
 * must then rebuild its panels even for its own echo, because the values they show changed
 * underneath them.
 */
export function replacesProjectBranch(ops: readonly PatchOp[]): boolean {
  return ops.some((o) => o.path[0] === 'project' && o.path.length <= 2 && o.path[1] !== 'scenes' && o.path[1] !== 'transition');
}

/** Morph progress 0..1 at `nowMs` (1 when there is no morph or it has finished). */
export function morphProgress(morph: Pick<Morph, 'startWallMs' | 'duration'> | null, nowMs: number): number {
  if (!morph) return 1;
  const t = (nowMs - morph.startWallMs) / (morph.duration * 1000);
  return Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 1;
}
