import { Pane, type BladeApi } from 'tweakpane';
import { wallMs } from '../../shared/modulators.ts';
import { applyOps, type PatchOp } from '../../shared/patch.ts';
import { EASINGS_MORPH, ProjectSchema, SessionSchema, type Scene, type SyncDoc, type Transition } from '../../shared/project-schema.ts';
import {
  addSceneOps,
  deleteSceneOps,
  goToSceneOps,
  missingSceneDatasets,
  morphProgress,
  moveSceneOps,
  neighbourScene,
  newSceneId,
  nextSceneName,
  renameSceneOps,
  sceneMatches,
  sceneTransition,
  setSceneTransitionOps,
  updateSceneOps,
} from '../../shared/scene-helpers.ts';
import { askName, h, icon, iconButton } from './ui.ts';

/**
 * "Scenes" card: capture the current look as a named scene, go between scenes (the output
 * morphs over the transition), and manage the list. Going to a scene is one patch (see
 * scene-helpers.ts). The default transition is a small pane; each scene can override it
 * in its options row. The active scene is `session.morph.sceneId`; it is marked "edited"
 * when the project no longer matches it.
 */

export interface ScenesPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
  showError(message: string): void;
}

const EASING_TITLES: Record<Transition['easing'], string> = { linear: 'linear', smooth: 'smooth', 'ease-in': 'ease in', 'ease-out': 'ease out' };

function formatSeconds(s: number): string {
  return `${Number(s.toFixed(1))} s`;
}

function transitionText(t: Transition): string {
  return `${formatSeconds(t.duration)} · ${EASING_TITLES[t.easing]}`;
}

export class ScenesPanel {
  private list = h('ol', { className: 'scene-list' });
  private empty = h('p', { className: 'muted empty-note', textContent: 'No scenes yet. Set up a look, then capture it.' });
  private nameInput = h('input', { type: 'text', placeholder: 'Scene name', className: 'grow', spellcheck: false });
  private prevButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private transitionModel: Transition = { duration: 2, easing: 'smooth' };
  private transitionBindings: (BladeApi & { refresh(): void })[] = [];
  private quietDepth = 0;
  private dragging = false;
  /** Scene whose options row is open. */
  private openId: string | null = null;
  private builtScenes: Scene[] | null = null;
  private builtTransition: Transition | null = null;
  private builtActive: string | null = null;
  private seenProject: SyncDoc['project'] | null = null;
  private rows = new Map<string, { row: HTMLLIElement; bar: HTMLElement }>();

  constructor(
    root: HTMLElement,
    private deps: ScenesPanelDeps,
  ) {
    this.prevButton = h('button', { type: 'button', className: 'btn' }, icon('prev'), 'Previous');
    this.nextButton = h('button', { type: 'button', className: 'btn' }, 'Next', icon('next'));
    this.prevButton.title = 'Go to the previous scene';
    this.nextButton.title = 'Go to the next scene';
    this.prevButton.addEventListener('click', () => this.step(-1));
    this.nextButton.addEventListener('click', () => this.step(1));

    const capture = h('button', { type: 'button', className: 'btn primary' }, icon('camera'), 'Capture');
    capture.title = 'Save the current layers, camera, output and modulators as a new scene';
    capture.addEventListener('click', () => this.capture());
    this.nameInput.setAttribute('aria-label', 'Name for the new scene');
    this.nameInput.addEventListener('input', () => delete this.nameInput.dataset.auto);
    this.nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.capture();
    });

    const paneHost = h('div', { className: 'scene-transition' });
    root.append(
      h('div', { className: 'toolbar' }, this.nameInput, capture),
      this.list,
      this.empty,
      h('div', { className: 'toolbar split' }, this.prevButton, this.nextButton),
      h('h3', { className: 'sub-head', textContent: 'Default transition' }),
      paneHost,
    );

    const pane = new Pane({ container: paneHost });
    const m = this.transitionModel;
    this.transitionBindings.push(
      pane
        .addBinding(m, 'duration', { label: 'duration (s)', min: 0.1, max: 10, step: 0.1 })
        .on('change', (ev) => this.setDefaultTransition({ duration: ev.value }, ev.last)),
      pane
        .addBinding(m, 'easing', { options: EASINGS_MORPH.map((e) => ({ text: EASING_TITLES[e], value: e })) })
        .on('change', (ev) => this.setDefaultTransition({ easing: ev.value }, true)),
    );
    paneHost.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointercancel', () => (this.dragging = false));
  }

  // ---- reconciling -----------------------------------------------------------------------

  update(doc: SyncDoc): void {
    const p = doc.project;
    const active = doc.session.morph?.sceneId ?? null;
    if (p.transition !== this.builtTransition && !this.dragging) {
      this.builtTransition = p.transition;
      this.transitionModel.duration = p.transition.duration;
      this.transitionModel.easing = p.transition.easing;
      this.quiet(() => this.transitionBindings.forEach((b) => b.refresh()));
      this.builtScenes = null; // row texts show the default transition
    }
    if (p.scenes !== this.builtScenes || active !== this.builtActive) {
      this.builtScenes = p.scenes;
      this.builtActive = active;
      this.renderList(doc);
    }
    if (p !== this.seenProject) {
      this.seenProject = p;
      this.markEdited(doc);
    }
    if (!this.nameInput.value || this.nameInput.dataset.auto === '1') {
      this.nameInput.value = nextSceneName(p);
      this.nameInput.dataset.auto = '1';
    }
    this.prevButton.disabled = this.nextButton.disabled = p.scenes.length === 0;
  }

  /** Move the morph progress bar (about 10 times a second). */
  tick(nowMs: number): void {
    const morph = this.deps.getDoc()?.session.morph ?? null;
    for (const [id, r] of this.rows) {
      const t = morph && morph.sceneId === id ? morphProgress(morph, nowMs) : 1;
      r.row.classList.toggle('morphing', t < 1);
      r.bar.style.transform = `scaleX(${t})`;
    }
  }

  private markEdited(doc: SyncDoc): void {
    const active = doc.session.morph?.sceneId ?? null;
    for (const [id, r] of this.rows) {
      const scene = doc.project.scenes.find((s) => s.id === id);
      r.row.classList.toggle('edited', id === active && scene !== undefined && !sceneMatches(doc.project, scene));
    }
  }

  private renderList(doc: SyncDoc): void {
    // Keep keyboard focus on the same control across the rebuild.
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const p = doc.project;
    const active = doc.session.morph?.sceneId ?? null;
    if (this.openId !== null && !p.scenes.some((s) => s.id === this.openId)) this.openId = null;
    this.rows.clear();
    this.list.replaceChildren(...p.scenes.map((scene, i) => this.renderRow(doc, scene, i, scene.id === active)));
    this.empty.hidden = p.scenes.length > 0;
    if (focused) this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
    this.markEdited(doc);
    this.tick(wallMs());
  }

  private renderRow(doc: SyncDoc, scene: Scene, index: number, active: boolean): HTMLLIElement {
    const p = doc.project;
    const id = scene.id;
    const t = sceneTransition(p, scene);
    const key = (k: string) => ({ key: `${id}/${k}` });

    const go = h(
      'button',
      { type: 'button', className: 'scene-go', dataset: key('go') },
      h('span', { className: 'scene-num', textContent: String(index + 1) }),
      h('span', { className: 'scene-name', textContent: scene.name || '(unnamed)' }),
      h('span', { className: 'scene-edited', textContent: 'edited' }),
      h('span', { className: 'scene-meta', textContent: `${transitionText(t)}${scene.transition ? ' · own' : ''}` }),
    );
    go.title = `Go to “${scene.name}” (${transitionText(t)})`;
    if (active) go.setAttribute('aria-current', 'true');
    go.addEventListener('click', () => this.goTo(id));

    const open = this.openId === id;
    const more = iconButton('more', `Options for “${scene.name}”`, () => {
      this.openId = this.openId === id ? null : id;
      const d = this.deps.getDoc();
      if (d) this.renderList(d);
    });
    more.dataset.key = `${id}/more`;
    more.setAttribute('aria-expanded', String(open));

    const bar = h('span', { className: 'scene-bar' });
    const row = h(
      'li',
      { className: `scene-row${active ? ' active' : ''}${open ? ' open' : ''}` },
      h('div', { className: 'scene-main' }, go, more),
      h('div', { className: 'scene-progress' }, bar),
    );
    if (open) row.append(this.renderDetail(doc, scene, index));
    this.rows.set(id, { row, bar });
    return row;
  }

  private renderDetail(doc: SyncDoc, scene: Scene, index: number): HTMLElement {
    const id = scene.id;
    const count = doc.project.scenes.length;
    const btn = (label: string, k: string, onClick: () => void, disabled = false, cls = 'btn small') => {
      const b = h('button', { type: 'button', className: cls, textContent: label, disabled });
      b.dataset.key = `${id}/${k}`;
      b.addEventListener('click', onClick);
      return b;
    };
    const actions = h(
      'div',
      { className: 'toolbar wrap' },
      btn('Update from current', 'update', () => this.update1(id)),
      btn('Rename…', 'rename', () => void this.rename(id)),
      btn('Move up', 'up', () => this.send(moveSceneOps, id, -1), index === 0),
      btn('Move down', 'down', () => this.send(moveSceneOps, id, 1), index === count - 1),
      btn('Delete…', 'delete', () => this.remove(id), false, 'btn small danger'),
    );

    // Own transition: a switch, then duration and easing (sent when released / chosen).
    const own = scene.transition;
    const shown = own ?? doc.project.transition;
    const ownBox = h('input', { type: 'checkbox', checked: own !== null });
    ownBox.dataset.key = `${id}/own`;
    const range = h('input', { type: 'range', min: '0.1', max: '10', step: '0.1', value: String(shown.duration), disabled: own === null });
    range.dataset.key = `${id}/duration`;
    range.setAttribute('aria-label', 'Transition duration in seconds');
    const out = h('output', { textContent: formatSeconds(shown.duration) });
    const easing = h(
      'select',
      { disabled: own === null },
      ...EASINGS_MORPH.map((e) => h('option', { value: e, textContent: EASING_TITLES[e], selected: e === shown.easing })),
    );
    easing.dataset.key = `${id}/easing`;
    easing.setAttribute('aria-label', 'Transition easing');
    const current = (): Transition => ({ duration: Number(range.value), easing: easing.value as Transition['easing'] });
    ownBox.addEventListener('change', () => this.send(setSceneTransitionOps, id, ownBox.checked ? current() : null));
    range.addEventListener('input', () => (out.textContent = formatSeconds(Number(range.value))));
    range.addEventListener('change', () => this.send(setSceneTransitionOps, id, current()));
    easing.addEventListener('change', () => this.send(setSceneTransitionOps, id, current()));

    const missing = missingSceneDatasets(doc.project, scene);
    return h(
      'div',
      { className: 'scene-detail' },
      actions,
      h('label', { className: 'check' }, ownBox, ' Own transition'),
      h('div', { className: 'range-row' }, range, out, easing),
      missing.length > 0 ? h('p', { className: 'warn small', textContent: `Uses missing dataset${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` }) : null,
    );
  }

  // ---- actions ----------------------------------------------------------------------------

  /** Validate the result locally (project and session schemas), then send. */
  private sendChecked(ops: PatchOp[] | null, what: string): boolean {
    const doc = this.deps.getDoc();
    if (!doc || !ops) return false;
    try {
      const next = applyOps(doc, ops);
      const p = ProjectSchema.safeParse(next.project);
      const s = SessionSchema.safeParse(next.session);
      const issue = (!p.success ? p.error.issues[0] : undefined) ?? (!s.success ? s.error.issues[0] : undefined);
      if (issue) {
        this.deps.showError(`${what} not sent (${issue.path.join('.')}: ${issue.message}).`);
        return false;
      }
    } catch (err) {
      this.deps.showError(`${what} not sent (${String(err)}).`);
      return false;
    }
    this.deps.sendPatch(ops);
    return true;
  }

  private send<A extends unknown[]>(make: (p: SyncDoc['project'], id: string, ...args: A) => PatchOp[] | null, id: string, ...args: A): void {
    const doc = this.deps.getDoc();
    if (doc) this.sendChecked(make(doc.project, id, ...args), 'Scene change');
  }

  private capture(): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const name = this.nameInput.value.trim() || nextSceneName(doc.project);
    const id = newSceneId(doc.project);
    if (this.sendChecked(addSceneOps(doc.project, id, name), 'New scene')) {
      this.nameInput.value = '';
      this.nameInput.dataset.auto = '1';
    }
  }

  goTo(id: string): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const scene = doc.project.scenes.find((s) => s.id === id);
    const missing = scene ? missingSceneDatasets(doc.project, scene) : [];
    if (missing.length > 0) this.deps.showError(`Scene “${scene?.name}” uses datasets that are no longer in the project (${missing.join(', ')}); those layers will show nothing.`);
    this.sendChecked(goToSceneOps(doc.project, id, wallMs()), 'Scene change');
  }

  private step(delta: -1 | 1): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const next = neighbourScene(doc.project, doc.session.morph?.sceneId ?? null, delta);
    if (next) this.goTo(next.id);
  }

  private update1(id: string): void {
    const doc = this.deps.getDoc();
    const scene = doc?.project.scenes.find((s) => s.id === id);
    if (!doc || !scene) return;
    if (!sceneMatches(doc.project, scene) && !window.confirm(`Replace scene “${scene.name}” with what is showing now?`)) return;
    this.send(updateSceneOps, id);
  }

  private async rename(id: string): Promise<void> {
    const scene = this.deps.getDoc()?.project.scenes.find((s) => s.id === id);
    if (!scene) return;
    const name = await askName({
      title: 'Rename scene',
      label: 'Name',
      initial: scene.name,
      okText: 'Rename',
      validate: (v) => (v.length === 0 ? 'Enter a name.' : v.length > 80 ? 'Use at most 80 characters.' : null),
    });
    if (name !== null) this.send(renameSceneOps, id, name);
  }

  private remove(id: string): void {
    const scene = this.deps.getDoc()?.project.scenes.find((s) => s.id === id);
    if (!scene || !window.confirm(`Delete scene “${scene.name}”? The project keeps showing what it shows now.`)) return;
    this.send(deleteSceneOps, id);
  }

  private setDefaultTransition(change: Partial<Transition>, final: boolean): void {
    if (this.quietDepth > 0) return;
    // Slider drags send only the final value: nothing needs it live.
    if (!final) return;
    const doc = this.deps.getDoc();
    if (!doc) return;
    const value: Transition = { ...doc.project.transition, ...change };
    this.sendChecked([{ op: 'set', path: ['project', 'transition'], value }], 'Transition');
  }

  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }
}
