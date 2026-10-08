import type { Object3D } from 'three';

export interface FrameContext {
  /** Seconds since the output started (float64, from the single output clock). */
  time: number;
  /** Seconds since the previous frame, clamped. */
  dt: number;
  frame: number;
}

/** A built layer. Owns its GPU resources and must release them all in dispose(). */
export interface LayerInstance {
  readonly object: Object3D;
  update(ctx: FrameContext): void;
  dispose(): void;
}

export interface LayerError {
  id: string;
  message: string;
}

interface Slot {
  id: string;
  instance: LayerInstance | null;
  error: string | null;
}

/**
 * Owns the layer instances in the scene. Every build, update and dispose is fenced: a
 * throwing layer is hidden, flagged and skipped from then on — it never escapes into the
 * render loop.
 */
export class LayerHost {
  private slots: Slot[] = [];
  /** Kept as a stable array so status reporting doesn't allocate per frame. */
  private _errors: LayerError[] = [];

  constructor(
    private parent: Object3D,
    private onError: (id: string, message: string) => void,
    /** Compiles a freshly built layer; returns an error (e.g. shader compile log) or null. */
    private verify: (object: Object3D) => string | null = () => null,
  ) {}

  get errors(): readonly LayerError[] {
    return this._errors;
  }

  /** Build (or rebuild) a layer. On failure the slot stays, flagged, with no instance. */
  set(id: string, build: () => LayerInstance): void {
    this.remove(id);
    const slot: Slot = { id, instance: null, error: null };
    this.slots.push(slot);
    try {
      slot.instance = build();
      const problem = this.verify(slot.instance.object);
      if (problem) throw new Error(problem);
      this.parent.add(slot.instance.object);
    } catch (err) {
      this.fail(slot, `build failed: ${describe(err)}`);
    }
  }

  get(id: string): LayerInstance | null {
    return this.slots.find((s) => s.id === id)?.instance ?? null;
  }

  /** True when the layer's slot exists and has been flagged as failed. */
  failed(id: string): boolean {
    return this.slots.find((s) => s.id === id)?.error != null;
  }

  /**
   * Remove a slot without disposing its instance, which stays in the scene: the caller now
   * owns it and must remove and dispose it (scene morphs fade old instances out this way).
   */
  detach(id: string): LayerInstance | null {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const slot = this.slots[i]!;
    this.slots.splice(i, 1);
    this.refreshErrors();
    return slot.instance;
  }

  /** Run `fn` on a layer's instance inside the fence; failed or missing layers are skipped. */
  call<T extends LayerInstance>(id: string, fn: (instance: T) => void): void {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot?.instance || slot.error) return;
    try {
      fn(slot.instance as T);
    } catch (err) {
      this.fail(slot, `update failed: ${describe(err)}`);
    }
  }

  /** Draw order and visibility. A failed layer stays hidden whatever `visible` says. */
  place(id: string, order: number, visible: boolean): void {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot?.instance) return;
    slot.instance.object.renderOrder = order;
    slot.instance.object.visible = visible && !slot.error;
  }

  ids(): string[] {
    return this.slots.map((s) => s.id);
  }

  remove(id: string): void {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const slot = this.slots[i]!;
    this.slots.splice(i, 1);
    this.release(slot);
    this.refreshErrors();
  }

  update(ctx: FrameContext): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.instance || slot.error) continue;
      try {
        slot.instance.update(ctx);
      } catch (err) {
        this.fail(slot, `update failed: ${describe(err)}`);
      }
    }
  }

  /** Rebuild every layer, e.g. after a WebGL context restore. */
  rebuildAll(rebuild: (id: string) => (() => LayerInstance) | null): void {
    for (const id of this.slots.map((s) => s.id)) {
      const build = rebuild(id);
      if (build) this.set(id, build);
    }
  }

  disposeAll(): void {
    for (const slot of this.slots) this.release(slot);
    this.slots = [];
    this.refreshErrors();
  }

  private fail(slot: Slot, message: string): void {
    slot.error = message;
    if (slot.instance) slot.instance.object.visible = false;
    this.refreshErrors();
    try {
      this.onError(slot.id, message);
    } catch {
      // reporting must never throw back into the loop
    }
  }

  private release(slot: Slot): void {
    if (!slot.instance) return;
    try {
      slot.instance.object.removeFromParent();
      slot.instance.dispose();
    } catch (err) {
      this.onError(slot.id, `dispose failed: ${describe(err)}`);
    }
    slot.instance = null;
  }

  private refreshErrors(): void {
    this._errors = this.slots.filter((s) => s.error).map((s) => ({ id: s.id, message: s.error! }));
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
