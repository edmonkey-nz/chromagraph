import type { LayerConfig } from '../../shared/layer-schema.ts';
import {
  applyLerpPlan,
  buildLerpPlan,
  ease,
  lerp,
  lerpCamera,
  lerpEffects,
  morphProgress,
  parseHex,
  type LerpPlan,
  type MorphEasing,
  type RGB,
} from '../../shared/morph-plan.ts';
import { defaultCamera, type Camera, type Morph, type OrbitCamera, type SyncDoc } from '../../shared/project-schema.ts';
import type { ApplicableLayer, CameraMode, LayerManager } from './layer-manager.ts';
import type { FrameContext } from './layers/layer.ts';
import { INSTANCER_LAYOUT_KEYS, type InstancerInstance } from './layers/instancer.ts';
import type { Stage } from './stage.ts';

/*
 * Scene morphs. A control window going to a scene sends one patch that copies the scene
 * into the project and sets session.morph. When applyDoc sees a morph newer than the last
 * one handled, begin() captures what is on screen right now (including a morph still in
 * progress, so interrupting one is seamless) and then, every frame until it ends, blends
 * from that frozen state to the live target.
 *
 * Per layer, by id:
 *   lerp     same type and structure key on both sides: the same instance is kept and its
 *            config is blended with a prebuilt lerp plan (morph-plan.ts) through the normal
 *            apply path. Instancers also move their marks between layouts by position
 *            (see instancer.ts), so calendar -> spiral glides instead of jumping.
 *   ghost    the old instance cannot become the new layer (different type or structure,
 *            or the layer is gone): it is detached from the LayerManager, kept in the scene
 *            and faded out on its frozen config, then disposed.
 *   fade-in  a new instance (new layer, or the rebuilt side of a ghost) fades in from 0.
 *            One still waiting for its data starts fading when the data arrives.
 * A layer enabled on only one side fades its opacity instead of popping.
 *
 * Modulators keep running during a morph. The modulation engine runs first each frame; its
 * effective configs for morphing layers (and the camera and output) are handed here
 * instead of straight to the layers, and the morph blends from the frozen "from" state to
 * that current, modulated target. Nothing is allocated per frame: plans, scratch configs
 * and the camera/effects scratch objects are all made in begin().
 *
 * When everything has reached t = 1 the exact target (base or modulated) is applied and all
 * overrides are dropped, so nothing of the morph lingers.
 */

interface Timing {
  start: number;
  /** Seconds. */
  duration: number;
  easing: MorphEasing;
}

interface LayerEntry {
  id: string;
  kind: 'lerp' | 'fade-in';
  /** The project's config for this layer (the target before modulation). */
  target: LayerConfig;
  /** Lerp: frozen on-screen config at the start (owned). Fade-in: unused. */
  from: LayerConfig | null;
  /** Opacity on screen at the start (0 when the layer was hidden). */
  fromOpacity: number;
  plan: LerpPlan<LayerConfig>;
  /** Manager key the entry was built against; a change means the instance was rebuilt. */
  key: string | undefined;
  /** Fade-in start (wall ms); null while waiting for the layer to be built. */
  start: number | null;
  /** This frame's modulated target, if the layer is modulated (cleared every frame). */
  modulated: LayerConfig | null;
  layout: boolean;
  done: boolean;
}

interface Ghost {
  id: string;
  instance: ApplicableLayer<LayerConfig>;
  config: LayerConfig;
  fromOpacity: number;
  cameraMode: CameraMode;
  timing: Timing;
}

export interface MorphDeps {
  manager(): LayerManager | null;
  stage(): Stage | null;
  report(message: string): void;
}

export class MorphEngine {
  private lastStart = -Infinity;
  private timing: Timing = { start: 0, duration: 1, easing: 'linear' };
  private entries: LayerEntry[] = [];
  private byId = new Map<string, LayerEntry>();
  private ghosts: Ghost[] = [];
  private doc: SyncDoc | null = null;

  private cameraActive = false;
  private readonly fromCamera: Camera = defaultCamera();
  private readonly outCamera: Camera = defaultCamera();
  private modCamera: Camera | null = null;

  private outputActive = false;
  private readonly fromBackground: RGB = { r: 0, g: 0, b: 0 };
  private readonly toBackground: RGB = { r: 0, g: 0, b: 0 };

  /** Bound once so per-frame instance calls do not allocate closures. */
  private mix = 0;
  private readonly setMix = (inst: ApplicableLayer<LayerConfig>): void => {
    (inst as unknown as InstancerInstance).setLayoutMix(this.mix);
  };
  private readonly endLayout = (inst: ApplicableLayer<LayerConfig>): void => {
    (inst as unknown as InstancerInstance).endLayoutMorph();
  };
  private readonly beginLayout = (inst: ApplicableLayer<LayerConfig>): void => {
    (inst as unknown as InstancerInstance).beginLayoutMorph();
  };

  constructor(private deps: MorphDeps) {}

  /** True while anything is morphing (for the debug overlay). */
  get active(): boolean {
    return this.entries.length > 0 || this.ghosts.length > 0 || this.cameraActive || this.outputActive;
  }

  /**
   * Call at the top of applyDoc, before the new state is applied: if session.morph is newer
   * than the last one handled, capture what is on screen and start morphing to `doc`.
   * The first state after boot or a context restore (prev null) is shown directly.
   */
  begin(doc: SyncDoc, prev: SyncDoc | null): void {
    const morph = doc.session.morph;
    this.doc = doc;
    if (!morph || morph.startWallMs <= this.lastStart) return;
    this.lastStart = morph.startWallMs;
    if (!prev) return;
    try {
      this.start(doc, morph);
    } catch (err) {
      this.deps.report(`scene morph failed to start: ${String(err)}; switching directly`);
      this.abandon();
    }
  }

  /** Call at the end of applyDoc (after the layers were synced). */
  afterSync(doc: SyncDoc): void {
    this.doc = doc;
    if (this.entries.length === 0) return;
    const manager = this.deps.manager();
    if (!manager) return;
    try {
      const layers = new Map(doc.project.layers.map((l) => [l.id, l]));
      for (const e of this.entries) {
        if (e.done) continue;
        const layer = layers.get(e.id);
        if (!layer) {
          // Removed mid-morph: the manager has already dropped it.
          this.retire(e, manager, false);
          continue;
        }
        const key = manager.keyOfBuilt(e.id);
        if (e.kind === 'lerp' && key !== e.key) {
          // Rebuilt mid-morph (its structure changed): the old picture is gone, fade the new one in.
          e.kind = 'fade-in';
          e.start = null;
          e.from = null;
          e.fromOpacity = 0;
          if (e.layout) e.layout = false;
          manager.setForcedVisible(e.id, false);
        }
        if (layer !== e.target || key !== e.key) {
          e.target = layer;
          e.key = key;
          e.plan = e.kind === 'lerp' && e.from ? this.lerpPlan(e.from, layer) : buildLerpPlan(layer, layer);
        }
        if (e.kind === 'fade-in' && e.start === null && manager.isBuilt(e.id)) e.start = this.timing.start;
      }
      this.compact();
    } catch (err) {
      this.deps.report(`scene morph failed: ${String(err)}; switching directly`);
      this.abandon();
    }
  }

  /** Modulated layer config for this frame. Returns true when the morph takes it. */
  layerModulated(id: string, effective: LayerConfig): boolean {
    const e = this.byId.get(id);
    if (!e || e.done || (e.kind === 'fade-in' && e.start === null)) return false;
    e.modulated = effective;
    return true;
  }

  cameraModulated(effective: Camera): boolean {
    if (!this.cameraActive) return false;
    this.modCamera = effective;
    return true;
  }

  /** Advance every morph to wall time `nowMs`. Runs after modulation, before rendering. */
  frame(nowMs: number, ctx: FrameContext): void {
    if (!this.active) return;
    const manager = this.deps.manager();
    const stage = this.deps.stage();
    const doc = this.doc;
    if (!manager || !stage || !doc) return;
    try {
      const u = this.eased(this.timing, nowMs);
      this.frameLayers(manager, nowMs, u);
      this.frameGhosts(nowMs, ctx);
      if (this.cameraActive) {
        const target = this.modCamera ?? doc.project.camera;
        if (u >= 1) {
          stage.setCamera(target);
          this.cameraActive = false;
        } else {
          stage.setCamera(lerpCamera(this.fromCamera, target, u, this.outCamera));
        }
      }
      if (this.outputActive) {
        if (u >= 1) {
          stage.setBackground(doc.project.output.background);
          this.outputActive = false;
        } else {
          const f = this.fromBackground;
          const t = parseHex(doc.project.output.background, this.toBackground);
          stage.setBackgroundRGB(lerp(f.r, t.r / 255, u), lerp(f.g, t.g / 255, u), lerp(f.b, t.b / 255, u));
        }
      }
    } catch (err) {
      this.deps.report(`scene morph failed: ${String(err)}; switching directly`);
      this.abandon();
    }
    this.modCamera = null;
  }

  /** Drop everything without applying (WebGL context restore: the caller rebuilds and reapplies). */
  reset(): void {
    for (const g of this.ghosts) this.disposeGhost(g);
    this.ghosts = [];
    const manager = this.deps.manager();
    for (const e of this.entries) manager?.setForcedVisible(e.id, false);
    this.entries = [];
    this.byId.clear();
    this.cameraActive = false;
    this.outputActive = false;
  }

  // ---- start -----------------------------------------------------------------------

  private start(doc: SyncDoc, morph: Morph): void {
    const manager = this.deps.manager();
    const stage = this.deps.stage();
    if (!manager || !stage) return;
    this.timing = { start: morph.startWallMs, duration: morph.duration, easing: morph.easing };

    // Camera and output from what is displayed now (already blended if a morph was running).
    copyCamera(stage.displayedCamera, this.fromCamera);
    stage.readBackground(this.fromBackground);
    this.cameraActive = true;
    this.outputActive = true;
    this.modCamera = null;

    // Release the previous morph's overrides; the new one decides afresh.
    for (const e of this.entries) manager.setForcedVisible(e.id, false);
    const previous = new Map(this.entries.map((e) => [e.id, e]));
    this.entries = [];
    this.byId.clear();

    const targets = new Map(doc.project.layers.map((l) => [l.id, l]));
    const lerped = new Set<string>();
    for (const id of manager.builtIds()) {
      const shown = manager.displayedConfig(id);
      if (!shown) continue;
      const visible = manager.isVisible(id);
      const fromOpacity = visible ? shown.opacity : 0;
      const target = targets.get(id);
      const key = manager.keyOfBuilt(id);
      if (target && target.type === shown.type && manager.keyFor(target, doc) === key) {
        if (fromOpacity === 0 && !target.enabled) continue; // hidden on both sides
        const from = structuredClone(shown);
        const layout = target.type === 'instancer';
        if (layout) manager.call(id, this.beginLayout);
        this.add({
          id,
          kind: 'lerp',
          target,
          from,
          fromOpacity,
          plan: this.lerpPlan(from, target),
          key,
          start: this.timing.start,
          modulated: null,
          layout,
          done: false,
        });
        manager.setForcedVisible(id, true);
        lerped.add(id);
      } else if (fromOpacity > 0) {
        const instance = manager.detach(id);
        if (instance) {
          this.ghosts.push({
            id,
            instance,
            config: structuredClone(shown),
            fromOpacity,
            cameraMode: shown.screenFixed ? '2d' : manager.cameraMode,
            timing: this.timing,
          });
        }
      }
    }

    // A previous layout morph not carried on (the layer is hidden on both sides now) must
    // not linger; ghosts keep theirs, frozen, as they fade.
    for (const [id, e] of previous) if (e.layout && !lerped.has(id)) manager.call(id, this.endLayout);

    for (const layer of doc.project.layers) {
      if (lerped.has(layer.id) || !layer.enabled) continue;
      this.add({
        id: layer.id,
        kind: 'fade-in',
        target: layer,
        from: null,
        fromOpacity: 0,
        plan: buildLerpPlan(layer, layer),
        key: undefined,
        start: null, // set by afterSync if built straight away, else when its data arrives
        modulated: null,
        layout: false,
        done: false,
      });
    }
  }

  private add(e: LayerEntry): void {
    this.entries.push(e);
    this.byId.set(e.id, e);
  }

  private lerpPlan(from: LayerConfig, target: LayerConfig): LerpPlan<LayerConfig> {
    return buildLerpPlan(from, target, { targetOnly: target.type === 'instancer' ? INSTANCER_WITH_TIMELINE : TIMELINE_ONLY });
  }

  // ---- per frame -------------------------------------------------------------------

  private frameLayers(manager: LayerManager, nowMs: number, u: number): void {
    let finished = false;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.done) continue;
      const target = e.modulated ?? e.target;
      e.modulated = null;
      if (e.kind === 'fade-in') {
        if (e.start === null) {
          if (!manager.isBuilt(e.id)) continue; // still waiting for data
          e.start = Math.max(nowMs, this.timing.start);
          e.key = manager.keyOfBuilt(e.id);
        }
        const v = this.eased(this.timing, nowMs, e.start);
        if (v >= 1) {
          this.retire(e, manager, true, target);
          finished = true;
          continue;
        }
        const cfg = applyLerpPlan(e.plan, target, 1);
        cfg.opacity = target.opacity * v;
        manager.applyEffective(e.id, cfg);
        continue;
      }
      if (u >= 1) {
        this.retire(e, manager, true, target);
        finished = true;
        continue;
      }
      const cfg = applyLerpPlan(e.plan, target, u);
      cfg.opacity = lerp(e.fromOpacity, target.enabled ? target.opacity : 0, u);
      // Glow and trails switched on or off by the scene fade rather than pop.
      if (e.from) lerpEffects(e.from.effects, target.effects, u, cfg.effects);
      manager.applyEffective(e.id, cfg);
      if (e.layout) {
        this.mix = u;
        manager.call(e.id, this.setMix);
      }
    }
    if (finished) this.compact();
  }

  private frameGhosts(nowMs: number, ctx: FrameContext): void {
    let finished = false;
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i]!;
      const v = this.eased(g.timing, nowMs);
      if (v >= 1) {
        this.disposeGhost(g);
        this.ghosts[i] = null as unknown as Ghost;
        finished = true;
        continue;
      }
      try {
        g.config.opacity = g.fromOpacity * (1 - v);
        g.instance.apply(g.config, g.cameraMode);
        g.instance.update(ctx);
      } catch (err) {
        this.deps.report(`layer ${g.id}: fading out failed: ${String(err)}`);
        this.disposeGhost(g);
        this.ghosts[i] = null as unknown as Ghost;
        finished = true;
      }
    }
    if (finished) this.ghosts = this.ghosts.filter((g) => g !== null);
  }

  /** End one layer's morph: apply its exact target and drop every override. */
  private retire(e: LayerEntry, manager: LayerManager, apply: boolean, target: LayerConfig = e.target): void {
    e.done = true;
    if (apply) manager.applyEffective(e.id, target);
    if (e.layout) manager.call(e.id, this.endLayout);
    manager.setForcedVisible(e.id, false);
  }

  private compact(): void {
    if (!this.entries.some((e) => e.done)) return;
    this.entries = this.entries.filter((e) => !e.done);
    this.byId.clear();
    for (const e of this.entries) this.byId.set(e.id, e);
  }

  private eased(t: Timing, nowMs: number, start = t.start): number {
    return ease(t.easing, morphProgress(nowMs, start, t.duration));
  }

  /** Something went wrong: jump to the target state, keeping nothing of the morph. */
  private abandon(): void {
    const manager = this.deps.manager();
    for (const e of this.entries) {
      if (!manager || e.done) continue;
      try {
        this.retire(e, manager, true);
      } catch {
        // keep going: the next sync re-applies the base configs anyway
      }
    }
    this.entries = [];
    this.byId.clear();
    for (const g of this.ghosts) this.disposeGhost(g);
    this.ghosts = [];
    const stage = this.deps.stage();
    if (stage && this.doc) {
      stage.setCamera(this.doc.project.camera);
      stage.setBackground(this.doc.project.output.background);
    }
    this.cameraActive = false;
    this.outputActive = false;
  }

  private disposeGhost(g: Ghost): void {
    try {
      g.instance.object.removeFromParent();
      g.instance.dispose();
    } catch (err) {
      this.deps.report(`layer ${g.id}: dispose failed: ${String(err)}`);
    }
  }
}

/**
 * A layer's timeline switches straight to the target's: a duration lerping mid-morph would
 * whip its playhead back and forth.
 */
const TIMELINE_ONLY: ReadonlySet<string> = new Set(['timeline']);
const INSTANCER_WITH_TIMELINE: ReadonlySet<string> = new Set([...INSTANCER_LAYOUT_KEYS, 'timeline']);

function copyCamera(src: OrbitCamera, out: OrbitCamera): void {
  out.mode = src.mode;
  out.fov = src.fov;
  out.yaw = src.yaw;
  out.pitch = src.pitch;
  out.distance = src.distance;
  out.target[0] = src.target[0];
  out.target[1] = src.target[1];
  out.target[2] = src.target[2];
  out.projection = src.projection;
  out.dof.enabled = src.dof.enabled;
  out.dof.focus = src.dof.focus;
  out.dof.depth = src.dof.depth;
  out.dof.amount = src.dof.amount;
}
