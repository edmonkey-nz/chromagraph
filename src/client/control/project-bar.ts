import type { ClientMessage, SnapshotInfo } from '../../shared/protocol.ts';
import { cleanSnapshotLabel, projectNameError, saveLabel, SaveTracker, snapshotSummary, suggestCopyName } from '../../shared/save-status.ts';
import { askName, h, icon } from './ui.ts';

/**
 * Header project controls: switch project, New…, Save, Save As…, the snapshots menu and
 * the "Saved hh:mm:ss / Unsaved…" indicator. The server writes the project (autosave or
 * `saveNow`) and answers every write with `saved`; snapshots arrive as `snapshots` lists.
 */

export interface ProjectBarDeps {
  /** Send a message; false when not connected. */
  send(msg: ClientMessage): boolean;
  showError(message: string): void;
}

export interface ProjectBarElements {
  select: HTMLSelectElement;
  newButton: HTMLButtonElement;
  saveButton: HTMLButtonElement;
  saveAsButton: HTMLButtonElement;
  snapshotsButton: HTMLButtonElement;
  snapshotsCount: HTMLElement;
  snapshotsPopover: HTMLElement;
  saveState: HTMLElement;
}

export class ProjectBar {
  readonly tracker = new SaveTracker();
  private names: string[] = [];
  private current = '';
  private snapshots: { project: string; list: SnapshotInfo[] } = { project: '', list: [] };
  private labelInput = h('input', { type: 'text', placeholder: 'Snapshot label', spellcheck: false, className: 'grow' });
  private listEl = h('ul', { className: 'snapshot-list' });

  constructor(
    private el: ProjectBarElements,
    private deps: ProjectBarDeps,
  ) {
    el.select.addEventListener('change', () => this.send({ t: 'openProject', name: el.select.value }, 'Project not opened'));
    el.newButton.addEventListener('click', () => void this.newProject());
    el.saveButton.addEventListener('click', () => this.send({ t: 'saveNow' }, 'Not saved'));
    el.saveAsButton.addEventListener('click', () => void this.saveAs());

    // Snapshots menu (a popover: Escape and clicking outside close it).
    const create = h('button', { type: 'button', className: 'btn primary' }, icon('plus'), 'Take snapshot');
    create.addEventListener('click', () => this.createSnapshot());
    this.labelInput.setAttribute('aria-label', 'Snapshot label');
    this.labelInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.createSnapshot();
    });
    el.snapshotsPopover.replaceChildren(
      h('h2', { className: 'popover-title', textContent: 'Snapshots' }),
      h('p', { className: 'muted small', textContent: 'Named versions of this project, kept with it. Restoring replaces the current state (take a snapshot first if you want to keep it).' }),
      h('div', { className: 'toolbar' }, this.labelInput, create),
      this.listEl,
    );
    el.snapshotsPopover.addEventListener('toggle', (ev) => {
      if ((ev as ToggleEvent).newState !== 'open') return;
      this.placePopover();
      this.labelInput.focus();
    });
    window.addEventListener('resize', () => this.placePopover());
    this.renderSnapshots();
    this.renderState(Date.now());
  }

  // ---- inputs from the server --------------------------------------------------------------

  setProjects(names: string[]): void {
    this.names = names;
    this.renderSelect();
  }

  /** The open project (from the synced state); a switch forgets the save state. */
  setCurrent(name: string): void {
    if (name === this.current) return;
    this.current = name;
    this.tracker.reset();
    this.renderSelect();
    this.renderSnapshots();
    this.renderState(Date.now());
  }

  saved(project: string, at: number): void {
    if (project !== this.current) return;
    this.tracker.saved(at);
    this.renderState(Date.now());
  }

  setSnapshots(project: string, list: SnapshotInfo[]): void {
    this.snapshots = { project, list };
    this.renderSnapshots();
  }

  /** Re-evaluate the indicator (called on changes and from the ticker, for "overdue"). */
  renderState(nowMs: number): void {
    const s = this.tracker.state(nowMs);
    const node = this.el.saveState;
    node.textContent = saveLabel(s);
    node.className = `save-state ${s.kind === 'clean' ? 'ok' : s.overdue ? 'warn' : 'busy'}`;
    node.title = s.kind === 'clean' ? 'The project on disk matches what you see' : 'Changes are written automatically within a second; Save writes now';
  }

  // ---- rendering -------------------------------------------------------------------------------

  private renderSelect(): void {
    const names = this.names.includes(this.current) || !this.current ? this.names : [...this.names, this.current];
    this.el.select.replaceChildren(...names.map((n) => h('option', { value: n, textContent: n, selected: n === this.current })));
  }

  private renderSnapshots(): void {
    const list = this.snapshots.project === this.current ? this.snapshots.list : [];
    this.el.snapshotsCount.textContent = list.length > 0 ? String(list.length) : '';
    if (list.length === 0) {
      this.listEl.replaceChildren(h('li', { className: 'muted empty-note', textContent: 'No snapshots yet.' }));
      return;
    }
    this.listEl.replaceChildren(
      ...list.map((s) => {
        const restore = h('button', { type: 'button', className: 'btn small', textContent: 'Restore' });
        restore.addEventListener('click', () => this.restore(s));
        const del = h('button', { type: 'button', className: 'btn small ghost danger', textContent: 'Delete' });
        del.addEventListener('click', () => this.remove(s));
        restore.setAttribute('aria-label', `Restore snapshot “${s.label}”`);
        del.setAttribute('aria-label', `Delete snapshot “${s.label}”`);
        return h(
          'li',
          { className: 'snapshot' },
          h('div', { className: 'snapshot-text' }, h('span', { className: 'snapshot-label', textContent: s.label || '(no label)' }), h('span', { className: 'muted small', textContent: snapshotSummary(s) })),
          h('div', { className: 'snapshot-actions' }, restore, del),
        );
      }),
    );
  }

  private placePopover(): void {
    const pop = this.el.snapshotsPopover;
    if (!pop.matches(':popover-open')) return;
    const r = this.el.snapshotsButton.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 16);
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8)))}px`;
    pop.style.width = `${width}px`;
  }

  // ---- actions -----------------------------------------------------------------------------------

  private send(msg: ClientMessage, failure: string): boolean {
    if (this.deps.send(msg)) return true;
    this.deps.showError(`${failure}: not connected to the server.`);
    return false;
  }

  private async newProject(): Promise<void> {
    const name = await askName({ title: 'New project', label: 'Project name', okText: 'Create', validate: (v) => projectNameError(v, this.names) });
    if (name !== null) this.send({ t: 'createProject', name }, 'Project not created');
  }

  private async saveAs(): Promise<void> {
    if (!this.current) return;
    const name = await askName({
      title: 'Save as',
      label: 'Copy this project (and its data files) to a new project called',
      initial: suggestCopyName(this.current, this.names),
      okText: 'Save copy',
      validate: (v) => projectNameError(v, this.names),
    });
    if (name !== null) this.send({ t: 'duplicateProject', name }, 'Not saved');
  }

  private createSnapshot(): void {
    const label = cleanSnapshotLabel(this.labelInput.value) || `Snapshot ${this.snapshots.list.length + 1}`;
    if (this.send({ t: 'snapshotCreate', label }, 'Snapshot not taken')) this.labelInput.value = '';
  }

  private restore(s: SnapshotInfo): void {
    if (!window.confirm(`Restore snapshot “${s.label}”? The current layers, scenes and settings are replaced.`)) return;
    this.send({ t: 'snapshotRestore', id: s.id }, 'Snapshot not restored');
  }

  private remove(s: SnapshotInfo): void {
    if (!window.confirm(`Delete snapshot “${s.label}”? This cannot be undone.`)) return;
    this.send({ t: 'snapshotDelete', id: s.id }, 'Snapshot not deleted');
  }
}
