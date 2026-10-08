import type { BladeApi, ButtonApi, FolderApi } from 'tweakpane';
import { clampDuration, formatPosition, layerTransport, projectPhase, reanchor } from '../../shared/modulation-helpers.ts';
import { seek, setPlaying, timelinePhase, wallMs, type Transport } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';

/**
 * Timeline controls: duration, loop, play/pause, restart and a live phase slider. Used by
 * the "Timeline" card (the project timeline) and by each layer card's "Timeline" folder
 * (the layer's own timeline). The transport is shared session state; the slider follows it
 * locally (about 10 times a second, via `tick`) without sending anything, and only a user
 * drag sends a seek.
 */

export interface TimelinePanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
}

type Timeline = { duration: number; loop: boolean };

/** What a panel drives: where its timeline and transport live, and how to patch them. */
export interface TimelineTarget {
  /** The timeline shown, or null when there is none (a layer following the project). */
  timeline(doc: SyncDoc): Timeline | null;
  transport(doc: SyncDoc): Transport;
  /** Ops that set the timeline's duration / loop. */
  timelineOps(doc: SyncDoc, change: Partial<Timeline>): PatchOp[];
  transportOps(doc: SyncDoc, next: Transport): PatchOp[];
  /** Extra ops sent with Play/Pause or Restart (the project's also drive every layer's own timeline). */
  alsoOn?(doc: SyncDoc, action: 'play' | 'pause' | 'restart', nowMs: number): PatchOp[];
}

/** The project timeline (the Timeline card). Its Play/Pause and Restart drive every layer's own timeline too. */
export const projectTimeline: TimelineTarget = {
  timeline: (doc) => doc.project.timeline,
  transport: (doc) => doc.session.transport,
  timelineOps: (_doc, change) => Object.entries(change).map(([k, value]) => ({ op: 'set', path: ['project', 'timeline', k], value })),
  transportOps: (_doc, next) => [{ op: 'set', path: ['session', 'transport'], value: next }],
  alsoOn: (doc, action, nowMs) => {
    const ops: PatchOp[] = [];
    for (const layer of doc.project.layers) {
      const tl = layer.timeline;
      if (!tl.own) continue;
      const t = layerTransport(doc.session, layer.id);
      let next = action === 'restart' ? seek(t, 0, nowMs) : setPlaying(t, action === 'play', tl.duration, tl.loop, nowMs);
      if (action === 'play' && !tl.loop && next.anchorPhase >= 1) next = seek(next, 0, nowMs);
      ops.push({ op: 'set', path: ['session', 'layerTransports', layer.id], value: next });
    }
    return ops;
  },
};

/** A layer's own timeline (its card's Timeline folder). The layer is found by id at send time. */
export function layerTimeline(layerId: string): TimelineTarget {
  const index = (doc: SyncDoc) => doc.project.layers.findIndex((l) => l.id === layerId);
  return {
    timeline: (doc) => {
      const tl = doc.project.layers[index(doc)]?.timeline;
      return tl?.own ? tl : null;
    },
    transport: (doc) => layerTransport(doc.session, layerId),
    timelineOps: (doc, change) => {
      const i = index(doc);
      return i < 0 ? [] : Object.entries(change).map(([k, value]) => ({ op: 'set', path: ['project', 'layers', i, 'timeline', k], value }));
    },
    transportOps: (_doc, next) => [{ op: 'set', path: ['session', 'layerTransports', layerId], value: next }],
  };
}

/**
 * Ops that switch a layer's own timeline on or off. On, it starts as a copy of the project
 * timeline at the project's current position, so nothing jumps until it is changed.
 */
export function ownTimelineOps(doc: SyncDoc, layerId: string, own: boolean, nowMs: number): PatchOp[] {
  const i = doc.project.layers.findIndex((l) => l.id === layerId);
  if (i < 0) return [];
  if (!own) {
    const ops: PatchOp[] = [{ op: 'set', path: ['project', 'layers', i, 'timeline', 'own'], value: false }];
    if (doc.session.layerTransports[layerId]) ops.push({ op: 'remove', path: ['session', 'layerTransports', layerId] });
    return ops;
  }
  const { duration, loop } = doc.project.timeline;
  const t = doc.session.transport;
  return [
    { op: 'set', path: ['project', 'layers', i, 'timeline'], value: { own: true, duration, loop } },
    {
      op: 'set',
      path: ['session', 'layerTransports', layerId],
      value: { playing: t.playing, anchorWallMs: nowMs, anchorPhase: Math.min(Math.max(projectPhase(doc.project, t, nowMs), 0), 1) },
    },
  ];
}

/** Minimum gap between seeks sent while the phase slider is being dragged. */
const SCRUB_INTERVAL_MS = 50;

/** A binding, as far as this panel needs to know (its change handler is attached at creation). */
type Refreshable = BladeApi & { refresh(): void };

const QUICK_SET: { title: string; seconds: number }[] = [
  { title: '1 min', seconds: 60 },
  { title: '10 min', seconds: 600 },
  { title: '1 h', seconds: 3600 },
];

export class TimelinePanel {
  private model = { duration: 600, loop: true, phase: 0, position: '0:00 / 10:00' };
  private durationApi: Refreshable;
  private loopApi: Refreshable;
  private phaseApi: Refreshable;
  private positionApi: Refreshable;
  private playButton: ButtonApi;
  /** Every blade this panel added (hidden together while the target has no timeline). */
  private blades: BladeApi[] = [];
  /** Last transport we know of: the synced one, or the one we just sent (until it echoes). */
  private transport: Transport | null = null;
  private seenTransport: Transport | null = null;
  private seenTimeline: Timeline | null = null;
  /** Non-zero while the panel writes into its own bindings; change events are ignored then. */
  private quietDepth = 0;
  private dragging = false;
  private lastScrubMs = 0;

  constructor(
    parent: FolderApi,
    private deps: TimelinePanelDeps,
    private target: TimelineTarget = projectTimeline,
  ) {
    const f = parent;
    const m = this.model;
    const add = <T extends BladeApi>(b: T): T => {
      this.blades.push(b);
      return b;
    };

    this.durationApi = add(
      f.addBinding(m, 'duration', { label: 'duration (s)', min: 1, step: 1 }).on('change', (ev) => {
        if (this.quietDepth > 0) return;
        const v = clampDuration(ev.value);
        if (v !== ev.value) {
          m.duration = v;
          this.quiet(() => this.durationApi.refresh());
        }
        this.setTimeline({ duration: v });
      }),
    );
    QUICK_SET.forEach(({ title, seconds }, i) => {
      add(f.addButton({ title, label: i === 0 ? 'quick set' : '' })).on('click', () => {
        m.duration = seconds;
        this.quiet(() => this.durationApi.refresh());
        this.setTimeline({ duration: seconds });
      });
    });
    this.loopApi = add(
      f.addBinding(m, 'loop').on('change', (ev) => {
        if (this.quietDepth === 0) this.setTimeline({ loop: ev.value });
      }),
    );

    add(f.addBlade({ view: 'separator' }));
    this.playButton = add(f.addButton({ title: 'Play', label: 'transport' }));
    this.playButton.on('click', () => this.togglePlay());
    add(f.addButton({ title: 'Restart', label: '' })).on('click', () => this.seekTo(0, true));

    this.phaseApi = add(
      f.addBinding(m, 'phase', { label: 'phase', min: 0, max: 1, step: 0.0001 }).on('change', (ev) => {
        if (this.quietDepth > 0) return;
        const now = wallMs();
        // Scrub live while dragging (throttled); always send the final position.
        if (!ev.last && now - this.lastScrubMs < SCRUB_INTERVAL_MS) return;
        this.lastScrubMs = now;
        this.seekTo(ev.value, false);
      }),
    );
    // Track pointer drags on the slider, so the ticker never moves it under the user's hand.
    this.phaseApi.element.addEventListener('pointerdown', () => (this.dragging = true));
    const release = () => (this.dragging = false);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    this.positionApi = add(f.addBinding(m, 'position', { label: 'position', readonly: true, interval: 0 }));
  }

  /** Reconcile with a new document; refreshes duration and loop when they change. */
  update(doc: SyncDoc): void {
    const t = this.target.transport(doc);
    if (t !== this.seenTransport) {
      this.seenTransport = t;
      this.transport = t;
    }
    const tl = this.target.timeline(doc);
    for (const b of this.blades) b.hidden = tl === null;
    if (tl && tl !== this.seenTimeline) {
      // Don't overwrite the duration field while its text box is being edited.
      if (!this.editingText(this.durationApi)) this.model.duration = tl.duration;
      this.model.loop = tl.loop;
      this.quiet(() => {
        this.durationApi.refresh();
        this.loopApi.refresh();
      });
    }
    this.seenTimeline = tl;
    this.playButton.title = t.playing ? 'Pause' : 'Play';
    this.tick(wallMs());
  }

  /** Move the phase slider and position label on (call about 10 times a second). Sends nothing. */
  tick(nowMs: number): void {
    const doc = this.deps.getDoc();
    const tl = doc ? this.target.timeline(doc) : null;
    if (!doc || !tl || !this.transport) return;
    const phase = timelinePhase(this.transport, tl.duration, tl.loop, nowMs);
    const interacting = this.dragging || this.editingText(this.phaseApi);
    const shown = interacting ? this.model.phase : phase;
    this.model.position = formatPosition(shown, tl.duration);
    this.quiet(() => {
      if (!interacting && this.model.phase !== phase) {
        this.model.phase = phase;
        this.phaseApi.refresh();
      }
      this.positionApi.refresh();
    });
  }

  // ---- sending ---------------------------------------------------------------------------

  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }

  private editingText(api: BladeApi): boolean {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && api.element.contains(a);
  }

  private sendTransport(doc: SyncDoc, next: Transport, extra: PatchOp[] = []): void {
    this.transport = next;
    this.playButton.title = next.playing ? 'Pause' : 'Play';
    this.deps.sendPatch([...extra, ...this.target.transportOps(doc, next)]);
  }

  /** Change duration or loop, re-anchoring the transport so the playhead does not jump. */
  private setTimeline(change: Partial<Timeline>): void {
    const doc = this.deps.getDoc();
    const tl = doc ? this.target.timeline(doc) : null;
    if (!doc || !tl || !this.transport) return;
    const wanted: Partial<Timeline> = {};
    if (change.duration !== undefined && change.duration !== tl.duration) wanted.duration = change.duration;
    if (change.loop !== undefined && change.loop !== tl.loop) wanted.loop = change.loop;
    const ops = this.target.timelineOps(doc, wanted);
    if (ops.length === 0) return;
    this.sendTransport(doc, reanchor(this.transport, tl, wallMs()), ops);
  }

  private togglePlay(): void {
    const doc = this.deps.getDoc();
    const tl = doc ? this.target.timeline(doc) : null;
    if (!doc || !tl || !this.transport) return;
    const now = wallMs();
    const playing = !this.transport.playing;
    let next = setPlaying(this.transport, playing, tl.duration, tl.loop, now);
    // A finished, non-looping timeline starts again from the beginning.
    if (playing && !tl.loop && next.anchorPhase >= 1) next = seek(next, 0, now);
    this.sendTransport(doc, next, this.target.alsoOn?.(doc, playing ? 'play' : 'pause', now) ?? []);
  }

  /** Seek to `phase`; Restart (`restart`) also restarts what the target drives with it. */
  private seekTo(phase: number, restart: boolean): void {
    const doc = this.deps.getDoc();
    if (!doc || !this.transport) return;
    const now = wallMs();
    this.sendTransport(doc, seek(this.transport, phase, now), restart ? (this.target.alsoOn?.(doc, 'restart', now) ?? []) : []);
  }
}
