import type { BladeApi, FolderApi } from 'tweakpane';
import type { PatchOp } from '../../shared/patch.ts';
import type { Effects, SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Output & effects" card: background, glow (bloom) and trails, plus the diagnostic
 * toggles. Every edit is a patch under `project.output` (or `session` for diagnostics);
 * the effect sliders are the base values of the `output.effects.*` parameters, so a
 * modulated one is labelled " ~" like the layer fields.
 */

export interface OutputPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
}

const MODULATED_SUFFIX = ' ~';

type Binding = BladeApi & { refresh(): void; label: string | null | undefined };

export class OutputPanel {
  private model = {
    background: '#000000',
    bloom: { enabled: false, strength: 0.8, radius: 0.4, threshold: 0.2 },
    trails: { enabled: false, persistence: 0.85 },
    testPattern: false,
    debugOverlay: false,
  };
  private bindings: Binding[] = [];
  private bloomFields: Binding[] = [];
  private trailFields: Binding[] = [];
  /** Modulatable bindings with their plain label and parameter id. */
  private marks: { api: Binding; label: string; id: string }[] = [];
  private quietDepth = 0;
  private seenParams: SyncDoc['project']['parameters'] | null = null;

  constructor(
    root: FolderApi,
    private deps: OutputPanelDeps,
  ) {
    const m = this.model;
    this.bindings.push(root.addBinding(m, 'background').on('change', (ev) => this.set(['background'], ev.value)) as Binding);

    const glow = root.addFolder({ title: 'Glow', expanded: true });
    this.bindings.push(
      glow.addBinding(m.bloom, 'enabled', { label: 'on' }).on('change', (ev) => {
        this.set(['effects', 'bloom', 'enabled'], ev.value);
        this.enableFields();
      }) as Binding,
    );
    this.bloomFields = [
      this.effect(glow, m.bloom, 'strength', 'strength', { min: 0, max: 3, step: 0.01 }, ['bloom', 'strength']),
      this.effect(glow, m.bloom, 'radius', 'radius', { min: 0, max: 1, step: 0.01 }, ['bloom', 'radius']),
      this.effect(glow, m.bloom, 'threshold', 'threshold', { min: 0, max: 1, step: 0.01 }, ['bloom', 'threshold']),
    ];

    const trails = root.addFolder({ title: 'Trails', expanded: true });
    this.bindings.push(
      trails.addBinding(m.trails, 'enabled', { label: 'on' }).on('change', (ev) => {
        this.set(['effects', 'trails', 'enabled'], ev.value);
        this.enableFields();
      }) as Binding,
    );
    this.trailFields = [this.effect(trails, m.trails, 'persistence', 'length', { min: 0, max: 0.99, step: 0.01 }, ['trails', 'persistence'])];
    this.trailFields[0]!.element.title = 'How much of each frame stays on the next (per 1/60 s): 0 = no trail, 0.95 = long smears';

    const diag = root.addFolder({ title: 'Diagnostics', expanded: false });
    this.bindings.push(
      diag
        .addBinding(m, 'testPattern', { label: 'test pattern' })
        .on('change', (ev) => this.send([{ op: 'set', path: ['session', 'testPattern'], value: ev.value }])) as Binding,
      diag
        .addBinding(m, 'debugOverlay', { label: 'debug overlay' })
        .on('change', (ev) => this.send([{ op: 'set', path: ['session', 'debugOverlay'], value: ev.value }])) as Binding,
    );
    this.enableFields();
  }

  private effect<T extends Record<string, unknown>>(
    folder: FolderApi,
    obj: T,
    key: keyof T & string,
    label: string,
    range: { min: number; max: number; step: number },
    path: [string, string],
  ): Binding {
    const api = folder.addBinding(obj, key, { label, ...range }).on('change', (ev) => this.set(['effects', ...path], ev.value)) as Binding;
    this.bindings.push(api);
    this.marks.push({ api, label, id: `output.effects.${path.join('.')}` });
    return api;
  }

  /**
   * Reconcile with a new document. `external` (other windows, full snapshots, scene changes)
   * copies everything; our own echoes only pick up the switches, which other panels may
   * share (the calibration panel also drives the test pattern).
   */
  update(doc: SyncDoc, external: boolean): void {
    const m = this.model;
    const out = doc.project.output;
    const s = doc.session;
    let changed = false;
    if (external) {
      m.background = out.background;
      copyEffects(m, out.effects);
      changed = true;
    }
    if (m.testPattern !== s.testPattern || m.debugOverlay !== s.debugOverlay) {
      m.testPattern = s.testPattern;
      m.debugOverlay = s.debugOverlay;
      changed = true;
    }
    if (m.bloom.enabled !== out.effects.bloom.enabled || m.trails.enabled !== out.effects.trails.enabled) {
      m.bloom.enabled = out.effects.bloom.enabled;
      m.trails.enabled = out.effects.trails.enabled;
      changed = true;
    }
    if (changed) {
      this.quiet(() => {
        for (const b of this.bindings) b.refresh();
      });
      this.enableFields();
    }
    if (doc.project.parameters !== this.seenParams) {
      this.seenParams = doc.project.parameters;
      for (const k of this.marks) k.api.label = doc.project.parameters[k.id] ? k.label + MODULATED_SUFFIX : k.label;
    }
  }

  private enableFields(): void {
    for (const b of this.bloomFields) b.disabled = !this.model.bloom.enabled;
    for (const b of this.trailFields) b.disabled = !this.model.trails.enabled;
  }

  private set(path: string[], value: unknown): void {
    this.send([{ op: 'set', path: ['project', 'output', ...path], value }]);
  }

  private send(ops: PatchOp[]): void {
    if (this.quietDepth === 0) this.deps.sendPatch(ops);
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

function copyEffects(m: { bloom: Effects['bloom']; trails: Effects['trails'] }, e: Effects): void {
  Object.assign(m.bloom, e.bloom);
  Object.assign(m.trails, e.trails);
}
