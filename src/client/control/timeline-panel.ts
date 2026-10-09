import type { BladeApi, ButtonApi, FolderApi } from 'tweakpane';
import { clampDuration, formatPosition, layerTransport, reanchor } from '../../shared/modulation-helpers.ts';
import { PLAYBACKS } from '../../shared/layer-schema.ts';
import {
  cyclePosition,
  cycleProgress,
  gapElapsed,
  playhead,
  progressFor,
  seek,
  setPlaying,
  transportSeconds,
  wallMs,
  type TimelineSettings,
  type Transport,
} from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { Project, SyncDoc } from '../../shared/project-schema.ts';

/**
 * Timeline controls: duration, loop, play/pause, restart and a live phase slider. Used by
 * the "Timeline" card (the project timeline) and by each layer card's "Timeline" folder
 * (the layer's own timeline). The transport is shared session state; the slider follows it
 * locally (about 10 times a second, via `tick`) without sending anything, and only a user
 * drag sends a seek. The project timeline also has fade in / fade out / fade length and a
 * gap before restart (see outputFade in modulation-helpers.ts and the gap in modulators.ts).
 */

export interface TimelinePanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
}

/** Timeline settings, with the fade fields only the project timeline has. */
type Timeline = TimelineSettings & Partial<Pick<Project['timeline'], 'fadeIn' | 'fadeOut' | 'fadeLength'>>;
/** The fields that only the project timeline has (ignored for a layer's own timeline). */
const PROJECT_ONLY = ['gap', 'fadeIn', 'fadeOut', 'fadeLength'] as const;
const TIMELINE_KEYS = ['duration', 'loop', 'playback', ...PROJECT_ONLY] as const;

/** What a panel drives: where its timeline and transport live, and how to patch them. */
export interface TimelineTarget {
  /** The timeline shown, or null when there is none (a layer following the project). */
  timeline(doc: SyncDoc): Timeline | null;
  transport(doc: SyncDoc): Transport;
  /** Ops that set the timeline's duration / loop / playback (and fades and gap, for the project). */
  timelineOps(doc: SyncDoc, change: Partial<Timeline>): PatchOp[];
  transportOps(doc: SyncDoc, next: Transport): PatchOp[];
  /** Extra ops sent with Play/Pause or Restart (the project's also drive every layer's own timeline). */
  alsoOn?(doc: SyncDoc, action: 'play' | 'pause' | 'restart', nowMs: number): PatchOp[];
  /** True for the project timeline: it has fades and a gap before restart. */
  fades?: boolean;
}

/** The project timeline (the Timeline card). Its Play/Pause and Restart drive every layer's own timeline too. */
export const projectTimeline: TimelineTarget = {
  fades: true,
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
      let next = action === 'restart' ? seek(t, 0, nowMs) : setPlaying(t, action === 'play', transportSeconds(tl), tl.loop, nowMs);
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
  const { duration, loop, playback } = doc.project.timeline;
  const t = doc.session.transport;
  // The layer's copy has no gap, so its anchor is the project's progress (held at 1 in a gap).
  return [
    { op: 'set', path: ['project', 'layers', i, 'timeline'], value: { own: true, duration, loop, playback } },
    {
      op: 'set',
      path: ['session', 'layerTransports', layerId],
      value: { playing: t.playing, anchorWallMs: nowMs, anchorPhase: Math.min(Math.max(cycleProgress(t, doc.project.timeline, nowMs), 0), 1) },
    },
  ];
}

/** A transport change for a target: the transport to show until it echoes, and the ops to send. */
export interface TransportEdit {
  next: Transport;
  ops: PatchOp[];
}

/**
 * Play/Pause from `current` (the last transport known or sent). A finished, non-looping
 * timeline starts again from the beginning. The project's also plays or pauses every layer's
 * own timeline. Null when the target has no timeline.
 */
export function playPauseEdit(doc: SyncDoc, target: TimelineTarget, current: Transport, nowMs: number): TransportEdit | null {
  const tl = target.timeline(doc);
  if (!tl) return null;
  const playing = !current.playing;
  let next = setPlaying(current, playing, transportSeconds(tl), tl.loop, nowMs);
  // (Without loop there is no gap, so the anchor is the progress.)
  if (playing && !tl.loop && next.anchorPhase >= 1) next = seek(next, 0, nowMs);
  return { next, ops: [...(target.alsoOn?.(doc, playing ? 'play' : 'pause', nowMs) ?? []), ...target.transportOps(doc, next)] };
}

/**
 * Seek the playhead to `phase` (a scrub: a ping-pong stays on its current leg), or Restart
 * (the start of the cycle, which also restarts what the target drives with it). A seek lands
 * in the pass, never in the gap before restart (seeking to the very end starts the gap).
 */
export function seekEdit(doc: SyncDoc, target: TimelineTarget, current: Transport, phase: number | 'restart', nowMs: number): TransportEdit | null {
  const tl = target.timeline(doc);
  if (!tl) return null;
  const restart = phase === 'restart';
  const u = restart ? 0 : progressFor(phase, tl.playback, cycleProgress(current, tl, nowMs));
  const next = seek(current, u, nowMs, tl);
  return { next, ops: [...(restart ? (target.alsoOn?.(doc, 'restart', nowMs) ?? []) : []), ...target.transportOps(doc, next)] };
}

/**
 * Change a timeline's duration, loop or playback (and, on the project timeline, its fades and
 * gap before restart), re-anchoring its transport from `current` so the playhead does not
 * jump. Null when the target has no timeline or nothing changes.
 */
export function timelineEdit(doc: SyncDoc, target: TimelineTarget, current: Transport, change: Partial<Timeline>, nowMs: number): TransportEdit | null {
  const tl = target.timeline(doc);
  if (!tl) return null;
  const wanted: Record<string, unknown> = {};
  for (const k of TIMELINE_KEYS) {
    const v = change[k];
    if (v === undefined || v === tl[k]) continue;
    if (!target.fades && (PROJECT_ONLY as readonly string[]).includes(k)) continue;
    wanted[k] = v;
  }
  const ops = target.timelineOps(doc, wanted as Partial<Timeline>);
  if (ops.length === 0) return null;
  const next = reanchor(current, tl, { ...tl, ...wanted }, nowMs);
  return { next, ops: [...ops, ...target.transportOps(doc, next)] };
}

/** Minimum gap between seeks sent while the phase slider is being dragged. */
export const SCRUB_INTERVAL_MS = 50;

/** A binding, as far as this panel needs to know (its change handler is attached at creation). */
type Refreshable = BladeApi & { refresh(): void };

/** Quick durations offered next to the duration field. */
export const QUICK_SET: { title: string; seconds: number }[] = [
  { title: '1 min', seconds: 60 },
  { title: '10 min', seconds: 600 },
  { title: '1 h', seconds: 3600 },
];

export class TimelinePanel {
  private model = {
    duration: 600,
    loop: true,
    playback: 'forward' as TimelineSettings['playback'],
    fadeIn: false,
    fadeOut: false,
    fadeLength: 1,
    gap: 0,
    phase: 0,
    position: '0:00 / 10:00',
  };
  private durationApi: Refreshable;
  private loopApi: Refreshable;
  private playbackApi: Refreshable;
  /** Fades and gap: the project timeline only (empty for a layer's own timeline). */
  private fadeApis: { fadeIn: Refreshable; fadeOut: Refreshable; fadeLength: Refreshable; gap: Refreshable } | null = null;
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
    this.playbackApi = add(
      f
        .addBinding(m, 'playback', {
          options: PLAYBACKS.map((p) => ({ text: p === 'pingpong' ? 'ping-pong (there and back)' : p, value: p })),
        })
        .on('change', (ev) => {
          if (this.quietDepth === 0) this.setTimeline({ playback: ev.value });
        }),
    );
    this.playbackApi.element.title = 'Forward 0 → 1, reverse 1 → 0, or ping-pong 0 → 1 → 0 (each way takes the duration)';

    if (target.fades) {
      const bind = <K extends 'fadeIn' | 'fadeOut' | 'fadeLength' | 'gap'>(key: K, params: Record<string, unknown>, tip: string): Refreshable => {
        const api = add(
          f.addBinding(m, key, params).on('change', (ev) => {
            if (this.quietDepth === 0) this.setTimeline({ [key]: ev.value });
          }),
        );
        api.element.title = tip;
        return api;
      };
      this.fadeApis = {
        fadeIn: bind('fadeIn', { label: 'fade in' }, 'Fade the whole output in from the background at the start of each pass'),
        fadeOut: bind('fadeOut', { label: 'fade out' }, 'Fade the whole output out to the background at the end of each pass'),
        fadeLength: bind('fadeLength', { label: 'fade length (s)', min: 0.1, max: 10, step: 0.1 }, 'Seconds each fade takes (at most half a pass)'),
        gap: bind('gap', { label: 'gap before restart (s)', min: 0, max: 5, step: 0.1 }, 'Seconds held at the end of each pass before a looping timeline starts again'),
      };
    }

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
      this.model.playback = tl.playback;
      const fades = this.fadeApis;
      if (fades) {
        this.model.fadeIn = tl.fadeIn ?? false;
        this.model.fadeOut = tl.fadeOut ?? false;
        this.model.fadeLength = tl.fadeLength ?? 1;
        this.model.gap = tl.gap ?? 0;
        fades.fadeLength.disabled = !this.model.fadeIn && !this.model.fadeOut;
        fades.gap.disabled = !tl.loop; // a timeline that plays once has no restart
      }
      this.quiet(() => {
        this.durationApi.refresh();
        this.loopApi.refresh();
        this.playbackApi.refresh();
        if (fades) for (const api of Object.values(fades)) api.refresh();
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
    const phase = playhead(this.transport, tl, nowMs);
    const interacting = this.dragging || this.editingText(this.phaseApi);
    const shown = interacting ? this.model.phase : phase;
    const inGap = !interacting && gapElapsed(cyclePosition(this.transport, tl, nowMs), tl) >= 0;
    this.model.position = formatPosition(shown, tl.duration, inGap);
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

  private sendTransport(next: Transport, ops: PatchOp[]): void {
    this.transport = next;
    this.playButton.title = next.playing ? 'Pause' : 'Play';
    this.deps.sendPatch(ops);
  }

  /** Change a timeline setting, re-anchoring the transport so the playhead does not jump. */
  private setTimeline(change: Partial<Timeline>): void {
    const doc = this.deps.getDoc();
    const edit = doc && this.transport ? timelineEdit(doc, this.target, this.transport, change, wallMs()) : null;
    if (edit) this.sendTransport(edit.next, edit.ops);
  }

  private togglePlay(): void {
    const doc = this.deps.getDoc();
    const edit = doc && this.transport ? playPauseEdit(doc, this.target, this.transport, wallMs()) : null;
    if (edit) this.sendTransport(edit.next, edit.ops);
  }

  /** Seek the playhead to `phase` (the slider), or Restart (`restart`). */
  private seekTo(phase: number, restart: boolean): void {
    const doc = this.deps.getDoc();
    const edit = doc && this.transport ? seekEdit(doc, this.target, this.transport, restart ? 'restart' : phase, wallMs()) : null;
    if (edit) this.sendTransport(edit.next, edit.ops);
  }
}
