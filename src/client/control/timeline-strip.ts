import { formatClock } from '../../shared/modulation-helpers.ts';
import { cycleProgress, playhead, wallMs, type TimelineSettings, type Transport } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import { formatTick, playbackTitle, tickStep } from '../../shared/timeline-view.ts';
import { playPauseEdit, projectTimeline, SCRUB_INTERVAL_MS, seekEdit, type TransportEdit } from './timeline-panel.ts';
import { h, icon, iconButton } from './ui.ts';

/**
 * The project timeline strip under the live preview: Play/Pause, Restart, the position, the
 * playback chip and a ruler with the moving playhead, as in the Timeline tab's header. Click or
 * drag the ruler to scrub.
 *
 * Transport actions are the same edits as the Timeline card and tab (`playPauseEdit`,
 * `seekEdit` on `projectTimeline`), so Play/Pause and Restart also drive layers with their own
 * timelines, and scrubbing does not.
 *
 * It is always on screen, so it is kept cheap: the ruler is a canvas redrawn only when its
 * width or the duration changes; per frame the playhead line moves (a transform, only when it
 * has moved half a pixel); the position text and Play/Pause icon are checked 10 times a second
 * and rewritten only when they change. It animates with requestAnimationFrame only while the
 * strip is on screen and the page is visible.
 */

export interface TimelineStripDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
}

/** Inset of phase 0 and 1 from the ruler's ends (as in the Timeline tab), so the ends stay grabbable. */
export const STRIP_PAD_X = 10;
const RULER_H = 26;
const READOUT_MS = 100;
/**
 * After a send, echoes of our earlier sends (still on their way) are ignored until the echo of
 * the last one arrives, or for this long at most (a rejected patch, or someone else's change).
 */
export const ECHO_WAIT_MS = 2000;

/** x (px, within a ruler of width w) of playhead phase p. */
export function stripX(phase: number, w: number): number {
  return STRIP_PAD_X + phase * Math.max(w - STRIP_PAD_X * 2, 1);
}

/** Playhead phase at x within a ruler of width w, clamped to 0..1. */
export function stripPhase(x: number, w: number): number {
  return Math.min(Math.max((x - STRIP_PAD_X) / Math.max(w - STRIP_PAD_X * 2, 1), 0), 1);
}

/** Which way the playhead moves at progress u: -1 for reverse and a ping-pong's way back. */
export function stripDirection(tl: TimelineSettings, u: number): 1 | -1 {
  return tl.playback === 'reverse' || (tl.playback === 'pingpong' && u > 0.5) ? -1 : 1;
}

/** "0:22 / 1:00", with " ◂" / " ▸" for the direction of a reverse or ping-pong playhead (as the Timeline tab shows). */
export function stripPosition(phase: number, tl: TimelineSettings, direction: 1 | -1): string {
  const d = tl.duration;
  const arrow = tl.playback === 'forward' ? '' : direction < 0 ? ' ◂' : ' ▸';
  return `${formatClock(phase * d, d)} / ${formatClock(d)}${arrow}`;
}

/** "forward · loop", "ping-pong · once". */
export function stripChip(tl: TimelineSettings): string {
  return `${playbackTitle(tl.playback)}${tl.loop ? ' · loop' : ' · once'}`;
}

function sameTransport(a: Transport, b: Transport): boolean {
  return a.playing === b.playing && a.anchorWallMs === b.anchorWallMs && a.anchorPhase === b.anchorPhase;
}

/**
 * The transport the strip shows: the synced one, or the one we last set (sent or, mid-drag,
 * not yet sent). Incoming transports are ignored while the ruler is being dragged, and after a
 * send until its echo arrives, so echoes of earlier seeks never pull the playhead back.
 */
export class StripTrack {
  local: Transport | null = null;
  scrubbing = false;
  private seen: Transport | null = null;
  private awaiting: Transport | null = null;
  private awaitUntil = 0;
  private lastSendMs = Number.NEGATIVE_INFINITY;

  /** A transport from the synced document. */
  sync(t: Transport, nowMs: number): void {
    if (t === this.seen) return;
    this.seen = t;
    if (this.scrubbing) return;
    if (this.awaiting) {
      if (!sameTransport(t, this.awaiting) && nowMs < this.awaitUntil) return;
      this.awaiting = null;
    }
    this.local = t;
  }

  /** Give up waiting for an echo that is overdue: show the synced transport again. */
  settle(nowMs: number): void {
    if (!this.awaiting || nowMs < this.awaitUntil || this.scrubbing) return;
    this.awaiting = null;
    if (this.seen) this.local = this.seen;
  }

  /** Whether a scrub step may be sent now (at most one per SCRUB_INTERVAL_MS while dragging). */
  due(nowMs: number): boolean {
    return nowMs - this.lastSendMs >= SCRUB_INTERVAL_MS;
  }

  /** We set `next` locally and, when `sent`, patched it. */
  set(next: Transport, sent: boolean, nowMs: number): void {
    this.local = next;
    if (!sent) return;
    this.lastSendMs = nowMs;
    this.awaiting = next;
    this.awaitUntil = nowMs + ECHO_WAIT_MS;
  }
}

/** Ruler colours, read from the page's CSS tokens once. */
interface Colours {
  muted: string;
  line: string;
}

export class TimelineStrip {
  private root = h('div', { className: 'tstrip' });
  private ruler = h('div', { className: 'tl-track tl-ruler tstrip-ruler', title: 'Click or drag to move the project playhead' });
  private canvas = h('canvas');
  private ctx: CanvasRenderingContext2D | null;
  private head = h('div', { className: 'tl-head-mark' });
  private playBtn: HTMLButtonElement;
  private posEl = h('span', { className: 'tl-pos tstrip-pos' });
  private chipEl = h('span', { className: 'tl-chip' });
  private colours: Colours;

  private track = new StripTrack();
  private doc: SyncDoc | null = null;
  private seenTimeline: SyncDoc['project']['timeline'] | null = null;
  private raf = 0;
  private onScreen = false;
  private width = 0;
  /** What the ruler canvas was last drawn for ("width:dpr:duration"). */
  private drawnKey = '';
  private lastX = -1;
  private lastReadoutMs = Number.NEGATIVE_INFINITY;
  /** The position text is rebuilt only when one of these changes. */
  private lastSec = -1;
  private lastDir = 0;
  private lastTimeline: TimelineSettings | null = null;
  private lastPlaying: boolean | null = null;
  /** The latest scrub position (sent or not), resent if the drag is cancelled. */
  private scrubPhase = 0;

  constructor(
    host: HTMLElement,
    private deps: TimelineStripDeps,
  ) {
    this.ctx = this.canvas.getContext('2d');
    this.playBtn = iconButton('play', 'Play', () => this.playPause(), 'tl-play');
    const restart = iconButton('restart', 'Restart (also restarts layers with their own timeline)', () => this.seek('restart', true));
    this.ruler.append(this.canvas, this.head);
    this.root.append(h('div', { className: 'tl-transport tstrip-bar' }, this.playBtn, restart, this.posEl, this.chipEl), this.ruler);
    host.append(this.root);
    const css = getComputedStyle(this.root);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    this.colours = { muted: v('--muted', '#7e8695'), line: v('--line', '#252a34') };
    this.bindRuler();

    new ResizeObserver(() => this.layout()).observe(this.ruler);
    new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) this.setOnScreen(e.isIntersecting);
    }).observe(this.root);
    document.addEventListener('visibilitychange', () => this.start());
  }

  /** Reconcile with a new document. */
  update(doc: SyncDoc): void {
    this.doc = doc;
    const now = wallMs();
    this.track.sync(doc.session.transport, now);
    const tl = doc.project.timeline;
    if (tl !== this.seenTimeline) {
      this.seenTimeline = tl;
      const chip = stripChip(tl);
      if (this.chipEl.textContent !== chip) this.chipEl.textContent = chip;
      this.drawRuler();
    }
    this.draw(now, true);
  }

  // ---- per frame ------------------------------------------------------------------------------

  private running(): boolean {
    return this.onScreen && !document.hidden;
  }

  private setOnScreen(on: boolean): void {
    this.onScreen = on;
    this.start();
  }

  private start(): void {
    if (!this.running() || this.raf) return;
    this.draw(wallMs(), true);
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.running()) return;
    this.raf = requestAnimationFrame(this.frame);
    this.draw(wallMs(), false);
  };

  /** Move the playhead; every READOUT_MS (or when forced) also the position text and Play/Pause. */
  private draw(nowMs: number, force: boolean): void {
    const doc = this.doc;
    if (!doc) return;
    const tl = doc.project.timeline;
    const readout = force || nowMs - this.lastReadoutMs >= READOUT_MS;
    if (readout) {
      this.lastReadoutMs = nowMs;
      this.track.settle(nowMs);
    }
    const t = this.track.local ?? doc.session.transport;
    const phase = playhead(t, tl, nowMs);
    if (this.width > 0) {
      const x = Math.round(stripX(phase, this.width) * 2) / 2;
      if (x !== this.lastX) {
        this.lastX = x;
        this.head.style.transform = `translateX(${x}px)`;
      }
    }
    if (!readout) return;
    const sec = Math.floor(phase * tl.duration);
    const dir = tl.playback === 'forward' ? 1 : stripDirection(tl, cycleProgress(t, tl, nowMs));
    if (sec !== this.lastSec || dir !== this.lastDir || tl !== this.lastTimeline) {
      this.lastSec = sec;
      this.lastDir = dir;
      this.lastTimeline = tl;
      this.posEl.textContent = stripPosition(phase, tl, dir);
    }
    if (t.playing !== this.lastPlaying) {
      this.lastPlaying = t.playing;
      const label = t.playing ? 'Pause' : 'Play';
      this.playBtn.title = label;
      this.playBtn.setAttribute('aria-label', label);
      this.playBtn.replaceChildren(icon(t.playing ? 'pause' : 'play'));
      this.playBtn.classList.toggle('playing', t.playing);
    }
  }

  // ---- ruler ------------------------------------------------------------------------------------

  /** The ruler changed size: resize its canvas and redraw. */
  private layout(): void {
    this.width = this.ruler.clientWidth;
    this.lastX = -1;
    this.drawRuler();
    if (this.doc) this.draw(wallMs(), false);
  }

  /** Ticks and labels in seconds of the project timeline, as on the Timeline tab's ruler. */
  private drawRuler(): void {
    const ctx = this.ctx;
    const w = this.width;
    const d = this.doc?.project.timeline.duration;
    if (!ctx || w <= 0 || d === undefined) return;
    const dpr = window.devicePixelRatio || 1;
    const key = `${w}:${dpr}:${d}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(RULER_H * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${RULER_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, RULER_H);

    const c = this.colours;
    const inner = Math.max(w - STRIP_PAD_X * 2, 1);
    const step = tickStep(d, inner);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    // Minor ticks between labelled ones, when there is room.
    const minor = step / 5;
    if ((minor / d) * inner >= 6) {
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      for (let i = 1, s = minor; s < d - 1e-9; i++, s = minor * i) {
        const x = Math.round(stripX(s / d, w)) + 0.5;
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = c.muted;
    ctx.fillStyle = c.muted;
    ctx.beginPath();
    let lastLabelEnd = Number.NEGATIVE_INFINITY;
    for (let i = 0; ; i++) {
      const s = Math.min(step * i, d);
      const x = Math.round(stripX(s / d, w)) + 0.5;
      ctx.moveTo(x, RULER_H - 10);
      ctx.lineTo(x, RULER_H);
      const text = formatTick(s, step, d);
      const tw = ctx.measureText(text).width;
      const tx = Math.min(Math.max(x - tw / 2, 0), w - tw);
      if (tx > lastLabelEnd + 6) {
        ctx.fillText(text, tx, 3);
        lastLabelEnd = tx + tw;
      }
      if (s >= d) break;
    }
    ctx.stroke();
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(stripX(0, w), RULER_H - 0.5);
    ctx.lineTo(stripX(1, w), RULER_H - 0.5);
    ctx.stroke();
  }

  /** Click or drag to scrub: the playhead follows the pointer; seeks are throttled and the last is always sent. */
  private bindRuler(): void {
    const el = this.ruler;
    const scrub = (ev: PointerEvent, final: boolean) => {
      this.scrubPhase = stripPhase(ev.clientX - el.getBoundingClientRect().left, el.clientWidth);
      this.seek(this.scrubPhase, final || this.track.due(wallMs()));
    };
    const stop = () => {
      this.track.scrubbing = false;
      el.classList.remove('scrubbing');
    };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      this.track.scrubbing = true;
      el.classList.add('scrubbing');
      scrub(ev, true);
    });
    el.addEventListener('pointermove', (ev) => {
      if (this.track.scrubbing && el.hasPointerCapture(ev.pointerId)) scrub(ev, false);
    });
    el.addEventListener('pointerup', (ev) => {
      if (!this.track.scrubbing) return;
      scrub(ev, true);
      stop();
    });
    // Cancelled (the capture was lost): the last position shown still goes out.
    el.addEventListener('pointercancel', () => {
      if (!this.track.scrubbing) return;
      this.seek(this.scrubPhase, true);
      stop();
    });
  }

  // ---- transport ------------------------------------------------------------------------------

  private apply(edit: TransportEdit | null, send: boolean): void {
    if (!edit) return;
    const now = wallMs();
    this.track.set(edit.next, send, now);
    if (send) this.deps.sendPatch(edit.ops);
    this.draw(now, true);
  }

  private playPause(): void {
    const doc = this.deps.getDoc();
    const current = this.track.local ?? doc?.session.transport;
    this.apply(doc && current ? playPauseEdit(doc, projectTimeline, current, wallMs()) : null, true);
  }

  /** Seek to `phase` (a scrub step, sent when `send`) or Restart. */
  private seek(phase: number | 'restart', send: boolean): void {
    const doc = this.deps.getDoc();
    const current = this.track.local ?? doc?.session.transport;
    this.apply(doc && current ? seekEdit(doc, projectTimeline, current, phase, wallMs()) : null, send);
  }
}
