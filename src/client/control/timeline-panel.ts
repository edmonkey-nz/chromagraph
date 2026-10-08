import type { BladeApi, ButtonApi, FolderApi } from 'tweakpane';
import { clampDuration, formatPosition, projectPhase, reanchor } from '../../shared/modulation-helpers.ts';
import { seek, setPlaying, wallMs, type Transport } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Timeline" card: duration, loop, play/pause, restart and a live
 * phase slider. The transport is shared session state; the slider follows it locally
 * (about 10 times a second, via `tick`) without sending anything, and only a user drag
 * sends a seek.
 */

export interface TimelinePanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
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
  /** Last transport we know of: the synced one, or the one we just sent (until it echoes). */
  private transport: Transport | null = null;
  private seenTransport: Transport | null = null;
  private seenTimeline: SyncDoc['project']['timeline'] | null = null;
  /** Non-zero while the panel writes into its own bindings; change events are ignored then. */
  private quietDepth = 0;
  private dragging = false;
  private lastScrubMs = 0;

  constructor(parent: FolderApi, private deps: TimelinePanelDeps) {
    // The card's pane is the panel's own container.
    const f = parent;
    const m = this.model;

    this.durationApi = f.addBinding(m, 'duration', { label: 'duration (s)', min: 1, step: 1 }).on('change', (ev) => {
      if (this.quietDepth > 0) return;
      const v = clampDuration(ev.value);
      if (v !== ev.value) {
        m.duration = v;
        this.quiet(() => this.durationApi.refresh());
      }
      this.setTimeline({ duration: v });
    });
    QUICK_SET.forEach(({ title, seconds }, i) => {
      f.addButton({ title, label: i === 0 ? 'quick set' : '' }).on('click', () => {
        m.duration = seconds;
        this.quiet(() => this.durationApi.refresh());
        this.setTimeline({ duration: seconds });
      });
    });
    this.loopApi = f.addBinding(m, 'loop').on('change', (ev) => {
      if (this.quietDepth === 0) this.setTimeline({ loop: ev.value });
    });

    f.addBlade({ view: 'separator' });
    this.playButton = f.addButton({ title: 'Play', label: 'transport' });
    this.playButton.on('click', () => this.togglePlay());
    f.addButton({ title: 'Restart', label: '' }).on('click', () => this.seekTo(0));

    this.phaseApi = f.addBinding(m, 'phase', { label: 'phase', min: 0, max: 1, step: 0.0001 }).on('change', (ev) => {
      if (this.quietDepth > 0) return;
      const now = wallMs();
      // Scrub live while dragging (throttled); always send the final position.
      if (!ev.last && now - this.lastScrubMs < SCRUB_INTERVAL_MS) return;
      this.lastScrubMs = now;
      this.seekTo(ev.value);
    });
    // Track pointer drags on the slider, so the ticker never moves it under the user's hand.
    this.phaseApi.element.addEventListener('pointerdown', () => (this.dragging = true));
    const release = () => (this.dragging = false);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    this.positionApi = f.addBinding(m, 'position', { label: 'position', readonly: true, interval: 0 });
  }

  /** Reconcile with a new document; refreshes duration and loop when they change. */
  update(doc: SyncDoc): void {
    const t = doc.session.transport;
    if (t !== this.seenTransport) {
      this.seenTransport = t;
      this.transport = t;
    }
    const tl = doc.project.timeline;
    if (tl !== this.seenTimeline) {
      this.seenTimeline = tl;
      // Don't overwrite the duration field while its text box is being edited.
      if (!this.editingText(this.durationApi)) this.model.duration = tl.duration;
      this.model.loop = tl.loop;
      this.quiet(() => {
        this.durationApi.refresh();
        this.loopApi.refresh();
      });
    }
    this.playButton.title = t.playing ? 'Pause' : 'Play';
    this.tick(wallMs());
  }

  /** Move the phase slider and position label on (call about 10 times a second). Sends nothing. */
  tick(nowMs: number): void {
    const doc = this.deps.getDoc();
    if (!doc || !this.transport) return;
    const phase = projectPhase(doc.project, this.transport, nowMs);
    const interacting = this.dragging || this.editingText(this.phaseApi);
    const shown = interacting ? this.model.phase : phase;
    this.model.position = formatPosition(shown, doc.project.timeline.duration);
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

  private sendTransport(next: Transport, extra: PatchOp[] = []): void {
    this.transport = next;
    this.playButton.title = next.playing ? 'Pause' : 'Play';
    this.deps.sendPatch([...extra, { op: 'set', path: ['session', 'transport'], value: next }]);
  }

  /** Change duration or loop, re-anchoring the transport so the playhead does not jump. */
  private setTimeline(change: { duration?: number; loop?: boolean }): void {
    const doc = this.deps.getDoc();
    if (!doc || !this.transport) return;
    const tl = doc.project.timeline;
    const ops: PatchOp[] = [];
    if (change.duration !== undefined && change.duration !== tl.duration) {
      ops.push({ op: 'set', path: ['project', 'timeline', 'duration'], value: change.duration });
    }
    if (change.loop !== undefined && change.loop !== tl.loop) ops.push({ op: 'set', path: ['project', 'timeline', 'loop'], value: change.loop });
    if (ops.length === 0) return;
    this.sendTransport(reanchor(this.transport, tl, wallMs()), ops);
  }

  private togglePlay(): void {
    const doc = this.deps.getDoc();
    if (!doc || !this.transport) return;
    const { duration, loop } = doc.project.timeline;
    const now = wallMs();
    const playing = !this.transport.playing;
    let next = setPlaying(this.transport, playing, duration, loop, now);
    // A finished, non-looping timeline starts again from the beginning.
    if (playing && !loop && next.anchorPhase >= 1) next = seek(next, 0, now);
    this.sendTransport(next);
  }

  private seekTo(phase: number): void {
    if (!this.transport) return;
    this.sendTransport(seek(this.transport, phase, wallMs()));
  }
}
