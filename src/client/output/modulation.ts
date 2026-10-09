import type { LayerConfig } from '../../shared/layer-schema.ts';
import { evaluate, playhead, sortKeys, type Modulator, type TimelineSettings } from '../../shared/modulators.ts';
import { clampParam, parameterDefs, parseParamId, readParam, type ParamDef } from '../../shared/parameters.ts';
import type { Camera, Project, SyncDoc } from '../../shared/project-schema.ts';

interface Binding {
  def: ParamDef;
  modulator: Modulator;
  base: number;
  /** Index into `owners` of the scratch object this binding writes into. */
  owner: number;
  write: (value: number) => void;
}

interface Owner {
  kind: 'camera' | 'output' | 'layer';
  /** Layer id for layer owners. */
  layerId: string | null;
  scratch: LayerConfig | Camera | Project['output'];
  dirty: boolean;
  /** A layer with its own timeline: its settings (its transport is read per frame). */
  timeline: TimelineSettings | null;
  /** Timeline phase for this owner's bindings, set at the start of each frame. */
  phase: number;
}

export interface ModulationTargets {
  applyLayer(layerId: string, effective: LayerConfig): void;
  applyCamera(effective: Camera): void;
  /** Effective output settings (effects) when one of them is modulated. */
  applyOutput(effective: Project['output']): void;
}

/**
 * Evaluates every modulated parameter once per frame and pushes the effective values into
 * the layers and camera.
 *
 * compile() runs when the project changes (not per frame): it deep-copies each modulated
 * layer/camera into a scratch object and prebuilds a setter per parameter. frame() then
 * only does arithmetic and writes numbers into those scratch objects — no allocation.
 * Parameters whose layer or channel no longer exists are skipped (the control window
 * lists them as orphans).
 */
export class ModulationEngine {
  private bindings: Binding[] = [];
  private owners: Owner[] = [];
  private doc: SyncDoc | null = null;
  private _phase = 0;

  constructor(private targets: ModulationTargets) {}

  /** The project timeline's phase on the last frame (0..1; layers with their own timeline differ). */
  get phase(): number {
    return this._phase;
  }

  get active(): number {
    return this.bindings.length;
  }

  /** Rebuild bindings if anything they depend on changed. Cheap when nothing did. */
  sync(doc: SyncDoc): void {
    const prev = this.doc;
    this.doc = doc;
    if (
      prev &&
      prev.project.parameters === doc.project.parameters &&
      prev.project.layers === doc.project.layers &&
      prev.project.camera === doc.project.camera &&
      prev.project.output === doc.project.output
    ) {
      return;
    }
    this.compile(doc);
  }

  private compile(doc: SyncDoc): void {
    const project = doc.project;
    const defs = new Map(parameterDefs(project).map((d) => [d.id, d]));
    const owners: Owner[] = [];
    const ownerIndex = new Map<string, number>();
    const bindings: Binding[] = [];

    for (const [id, param] of Object.entries(project.parameters)) {
      const def = defs.get(id);
      const target = parseParamId(id);
      const base = readParam(project, id);
      if (!def || !target || base === undefined) continue;

      const key = target.kind === 'layer' ? `layer:${target.layerId}` : target.kind;
      let index = ownerIndex.get(key);
      if (index === undefined) {
        const source =
          target.kind === 'camera'
            ? project.camera
            : target.kind === 'output'
              ? project.output
              : project.layers.find((l) => l.id === target.layerId);
        if (!source) continue;
        index = owners.length;
        const own = target.kind === 'layer' && 'timeline' in source && source.timeline.own ? source.timeline : null;
        owners.push({
          kind: target.kind,
          layerId: target.kind === 'layer' ? target.layerId : null,
          scratch: structuredClone(source) as Owner['scratch'],
          dirty: false,
          timeline: own ? { duration: own.duration, loop: own.loop, playback: own.playback } : null,
          phase: 0,
        });
        ownerIndex.set(key, index);
      }
      const scratch = owners[index]!.scratch as unknown as Record<string | number, unknown>;
      const write = makeSetter(scratch, target.path);
      if (!write) continue;
      const modulator: Modulator =
        param.modulator.kind === 'keyframes' ? { ...param.modulator, keys: sortKeys(param.modulator.keys) } : param.modulator;
      bindings.push({ def, modulator, base, owner: index, write });
    }

    this.owners = owners;
    this.bindings = bindings;
  }

  /** Evaluate all bindings at wall time `nowMs` and push changed owners. */
  frame(nowMs: number): void {
    const doc = this.doc;
    if (!doc) return;
    const timeline = doc.project.timeline;
    this._phase = playhead(doc.session.transport, timeline, nowMs);
    if (this.bindings.length === 0) return;

    // Layers with their own timeline run on their own transport (no allocation: a lookup each).
    for (let i = 0; i < this.owners.length; i++) {
      const o = this.owners[i]!;
      const t = o.timeline;
      o.phase = t ? playhead(doc.session.layerTransports[o.layerId!] ?? doc.session.transport, t, nowMs) : this._phase;
    }
    for (let i = 0; i < this.bindings.length; i++) {
      const b = this.bindings[i]!;
      const owner = this.owners[b.owner]!;
      b.write(clampParam(b.def, evaluate(b.modulator, b.base, nowMs, owner.phase)));
      owner.dirty = true;
    }
    for (let i = 0; i < this.owners.length; i++) {
      const o = this.owners[i]!;
      if (!o.dirty) continue;
      o.dirty = false;
      if (o.kind === 'camera') this.targets.applyCamera(o.scratch as Camera);
      else if (o.kind === 'output') this.targets.applyOutput(o.scratch as Project['output']);
      else this.targets.applyLayer(o.layerId!, o.scratch as LayerConfig);
    }
  }
}

/** Setter for a numeric leaf at `path` inside `root`, or null if the path is not a number. */
function makeSetter(root: Record<string | number, unknown>, path: (string | number)[]): ((v: number) => void) | null {
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string | number, unknown>)[path[i]!];
  }
  const leaf = path[path.length - 1];
  if (typeof node !== 'object' || node === null || leaf === undefined) return null;
  const parent = node as Record<string | number, unknown>;
  if (typeof parent[leaf] !== 'number') return null;
  return (v: number) => {
    parent[leaf] = v;
  };
}
