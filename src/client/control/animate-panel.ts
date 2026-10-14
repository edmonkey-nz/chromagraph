import type { BindingApi } from '@tweakpane/core';
import type { FolderApi } from 'tweakpane';
import type { LayerConfig } from '../../shared/layer-schema.ts';
import { EASINGS } from '../../shared/modulators.ts';
import { applyOps, type PatchOp } from '../../shared/patch.ts';
import { ProjectSchema, type SyncDoc } from '../../shared/project-schema.ts';
import {
  animateKind,
  followOps,
  MIN_ROWS_GAP,
  MIN_WINDOW,
  readFollow,
  readReveal,
  revealOps,
  type Reveal,
  type RevealMode,
} from '../../shared/reveal.ts';

export interface AnimatePanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
  showError(message: string): void;
}

const MODE_TEXT: Record<RevealMode, string> = {
  off: 'off (show the rows above)',
  build: 'build up (rows appear in order)',
  window: 'window (a span of rows slides through)',
  custom: 'custom (see Motion effects)',
};
const MODE_TITLE: Record<RevealMode, string> = {
  off: '',
  build: 'build up',
  window: 'window',
  custom: 'custom',
};

/**
 * The top of a layer's "Animate" folder: which rows show, and how they play out over the
 * timeline (shared/reveal.ts). Below it the layers panel adds the Timeline and Motion effects
 * folders. Like the other panels it holds no authoritative state: every edit is a patch, and
 * external changes (another window, the Timeline tab) are read back in update().
 */
export class AnimatePanel {
  private readonly m = {
    start: 0,
    end: 1,
    from: 0,
    mode: 'off' as RevealMode,
    width: 0.1,
    easing: 'linear' as Reveal['easing'],
    takes: '',
    span: 'full' as 'visible' | 'full',
    follow: false,
  };
  private readonly bindings: BindingApi[] = [];
  private readonly rowsKind: boolean;
  private quietDepth = 0;
  /** The mode as last shown (read back or sent), before the list changed it. */
  private shownMode: RevealMode = 'off';
  private fromApi: BindingApi | null = null;
  private widthApi: BindingApi | null = null;
  private easingApi: BindingApi | null = null;
  private takesApi: BindingApi | null = null;
  private spanApi: BindingApi | null = null;

  constructor(
    private readonly folder: FolderApi,
    private readonly layerId: string,
    private readonly deps: AnimatePanelDeps,
    doc: SyncDoc,
  ) {
    const layer = this.layer(doc);
    this.rowsKind = layer !== undefined && animateKind(layer) === 'rows';
    this.read(doc);
    if (layer === undefined) return;
    const kind = animateKind(layer);
    if (kind === 'rows') this.buildRows(layer);
    else if (kind === 'row') this.buildFollow();
    if (kind !== null) this.addTakes();
    this.show(doc);
  }

  /** Read the document back: values only when the change came from elsewhere, readouts always. */
  update(doc: SyncDoc, external: boolean): void {
    if (external) this.read(doc);
    this.show(doc);
  }

  /** The folder's title: "Animate", plus what it is doing. */
  title(): string {
    if (!this.rowsKind) return this.m.follow ? 'Animate · follow' : 'Animate';
    return this.m.mode === 'off' ? 'Animate' : `Animate · ${MODE_TITLE[this.m.mode]}`;
  }

  private layer(doc: SyncDoc): LayerConfig | undefined {
    return doc.project.layers.find((l) => l.id === this.layerId);
  }

  private read(doc: SyncDoc): void {
    const layer = this.layer(doc);
    if (!layer) return;
    const r = readReveal(doc.project, layer);
    if (r) {
      this.m.start = r.start;
      this.m.end = r.end;
      this.m.from = r.from;
      this.m.mode = r.mode;
      if (r.mode === 'window') this.m.width = r.width;
      this.m.easing = r.easing;
    }
    if (layer.type === 'instancer') this.m.span = layer.axes.span;
    if (layer.type === 'text') this.m.follow = readFollow(doc.project, layer.id) !== false;
  }

  /** Refresh every binding from the model, show the controls the mode needs, and the readout. */
  private show(doc: SyncDoc): void {
    const layer = this.layer(doc);
    if (layer) this.m.takes = takesText(doc, layer);
    const animated = this.m.mode === 'build' || this.m.mode === 'window';
    if (this.fromApi) this.fromApi.hidden = !animated;
    if (this.widthApi) this.widthApi.hidden = this.m.mode !== 'window';
    if (this.easingApi) this.easingApi.hidden = !animated;
    if (this.spanApi) {
      const axes = layer?.type === 'instancer' && (layer.axes.x.enabled || layer.axes.y.enabled);
      this.spanApi.hidden = !axes;
    }
    if (this.takesApi) this.takesApi.hidden = this.rowsKind ? !animated : !this.m.follow;
    this.quiet(() => {
      for (const b of this.bindings) b.refresh();
    });
    this.shownMode = this.m.mode;
    this.folder.title = this.title();
  }

  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }

  private add(b: BindingApi, title: string): BindingApi {
    b.element.title = title;
    this.bindings.push(b);
    return b;
  }

  private buildRows(layer: LayerConfig): void {
    const f = this.folder;
    const m = this.m;
    const start = this.add(
      f.addBinding(m, 'start', { label: 'rows from', min: 0, max: 1, step: 0.001 }),
      'The first row shown, as a share of the rows (0 = the first, 1 = the last). An animation starts here.',
    );
    const end = this.add(
      f.addBinding(m, 'end', { label: 'rows to', min: 0, max: 1, step: 0.001 }),
      'The last row shown, as a share of the rows. An animation ends here.',
    );
    // Keep start < end, and the starting point between them.
    const keepOrder = (moved: 'start' | 'end') => {
      if (m.start > m.end - MIN_ROWS_GAP) {
        if (moved === 'start') m.end = Math.min(1, m.start + MIN_ROWS_GAP);
        else m.start = Math.max(0, m.end - MIN_ROWS_GAP);
      }
      m.from = Math.min(Math.max(m.from, m.start), m.end);
      this.quiet(() => {
        for (const b of this.bindings) b.refresh();
      });
    };
    start.on('change', () => {
      keepOrder('start');
      this.sendReveal();
    });
    end.on('change', () => {
      keepOrder('end');
      this.sendReveal();
    });

    const mode = this.add(
      f.addBinding(m, 'mode', { label: 'reveal', options: (Object.keys(MODE_TEXT) as RevealMode[]).map((v) => ({ text: MODE_TEXT[v], value: v })) }),
      'How the rows play out over the timeline. Build up: from "rows from" to "rows to", one after another. Window: a span of rows slides from one to the other.',
    );
    mode.on('change', () => {
      if (this.quietDepth > 0) return;
      // A new animation starts from nothing; switching between build up and window keeps it.
      if (this.shownMode === 'off' || this.shownMode === 'custom') m.from = m.start;
      if (m.mode === 'custom') {
        // Custom is only ever read back (an LFO or keyframes on the rows); choosing it does nothing.
        const doc = this.deps.getDoc();
        if (doc) this.read(doc);
        if (doc) this.show(doc);
        return;
      }
      this.sendReveal();
      const doc = this.deps.getDoc();
      if (doc) this.show(doc);
    });
    this.fromApi = this.add(
      f.addBinding(m, 'from', { label: 'starts at', min: 0, max: 1, step: 0.001 }),
      'Where the rows end when the timeline starts: the rows from "rows from" up to here already show, and the rest arrive. Set it to "rows from" to start with nothing.',
    );
    this.fromApi.on('change', () => {
      if (this.quietDepth > 0) return;
      m.from = Math.min(Math.max(m.from, m.start), m.end);
      this.quiet(() => this.fromApi?.refresh());
      this.sendReveal();
    });
    this.widthApi = this.add(
      f.addBinding(m, 'width', { label: 'window width', min: MIN_WINDOW, max: 1, step: 0.01 }),
      'How many rows the window shows, as a share of all the rows.',
    );
    this.widthApi.on('change', () => this.sendReveal());
    this.easingApi = this.add(
      f.addBinding(m, 'easing', { options: EASINGS.map((e) => ({ text: e === 'linear' ? 'steady' : 'ease in and out', value: e })) }),
      'Steady: rows arrive at an even rate. Ease in and out: slow at the start and end.',
    );
    this.easingApi.on('change', () => this.sendReveal());

    if (layer.type === 'instancer') {
      this.spanApi = this.add(
        f.addBinding(m, 'span', {
          label: 'axes',
          options: [
            { text: 'full from the start', value: 'full' },
            { text: 'grow with the rows', value: 'visible' },
          ],
        }),
        'Full: the axis lines, ticks and gridlines cover every row the animation reaches from the start, and only the marks and their labels appear. Grow: they extend with the rows.',
      );
      this.spanApi.on('change', () => {
        if (this.quietDepth > 0) return;
        const doc = this.deps.getDoc();
        const index = doc?.project.layers.findIndex((l) => l.id === this.layerId) ?? -1;
        if (index >= 0) this.send([{ op: 'set', path: ['project', 'layers', index, 'axes', 'span'], value: m.span }], 'Axes');
      });
    }
  }

  private buildFollow(): void {
    const follow = this.add(
      this.folder.addBinding(this.m, 'follow', { label: 'follow timeline' }),
      'Show the row under the timeline’s playhead: the row runs from the first to the last over the timeline.',
    );
    follow.on('change', () => {
      if (this.quietDepth > 0) return;
      const doc = this.deps.getDoc();
      if (!doc) return;
      this.send(followOps(doc.project, this.layerId, this.m.follow), 'Follow timeline');
      this.show(doc);
    });
  }

  private addTakes(): void {
    this.takesApi = this.add(
      this.folder.addBinding(this.m, 'takes', { label: 'takes', readonly: true, interval: 0 }),
      'The animation runs over the timeline that drives this layer. Change its length in the Timeline folder below.',
    );
  }

  private sendReveal(): void {
    if (this.quietDepth > 0) return;
    const doc = this.deps.getDoc();
    if (!doc) return;
    const { start, end, from, mode, width, easing } = this.m;
    this.send(revealOps(doc.project, this.layerId, { start, end, from, mode, width, easing }), 'Animation');
  }

  /** Validate against the project schema locally, then send; on failure, report and read back. */
  private send(ops: PatchOp[], what: string): void {
    const doc = this.deps.getDoc();
    if (!doc || ops.length === 0) return;
    let message: string | null = null;
    try {
      const r = ProjectSchema.safeParse(applyOps(doc, ops).project);
      if (!r.success) {
        const issue = r.error.issues[0];
        message = `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}`;
      }
    } catch (err) {
      message = String(err);
    }
    if (message !== null) {
      this.deps.showError(`${what} not sent (${message}).`);
      this.read(doc);
      this.show(doc);
      return;
    }
    this.deps.sendPatch(ops);
  }
}

/** "60 s on the project timeline, looping", from the timeline that drives the layer. */
export function takesText(doc: SyncDoc, layer: LayerConfig): string {
  const own = layer.timeline.own;
  const tl = own ? layer.timeline : doc.project.timeline;
  const d = tl.duration;
  const length = d < 120 ? `${Math.round(d * 10) / 10} s` : `${Math.round((d / 60) * 10) / 10} min`;
  const how = [tl.loop ? 'loops' : 'once', tl.playback === 'forward' ? null : tl.playback].filter(Boolean).join(', ');
  return `${length} (${own ? 'own' : 'project'} timeline, ${how})`;
}
