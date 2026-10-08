/**
 * Which passes the output effects run in a frame, from each visible layer's own glow and
 * trails settings (LayerEffects). Pure; the output's PostEffects carries it out.
 *
 *   whole       every visible layer has the same settings: run the whole-image chain once
 *               with them (no extra scene passes; the common case, and how projects from
 *               before per-layer settings were drawn)
 *   trails      otherwise, each layer with trails is drawn on its own into its own history
 *               (its glow goes into the history, so it smears with it), then merged with the
 *               frame. Capped at MAX_TRAIL_LAYERS (each costs two full-size buffers)
 *   glowGroups  layers with glow but no trails, grouped by identical glow settings; each
 *               group is drawn once and its glow added to the frame
 *
 * Plans are written into a reused object: no allocation per frame.
 */

export const MAX_TRAIL_LAYERS = 8;

/** One visible layer's effective settings (an effect counts as on only with a non-zero amount). */
export interface FxLayer {
  /** Opaque handle for the caller (the layer's scene object). */
  object: unknown;
  glow: boolean;
  strength: number;
  radius: number;
  threshold: number;
  trails: boolean;
  persistence: number;
}

export interface EffectsPlan {
  /** Index of a layer whose settings every visible layer shares, or -1. */
  whole: number;
  /** Indices of the layers drawn with their own trail history. */
  trails: number[];
  trailCount: number;
  /** Trail layers beyond MAX_TRAIL_LAYERS, drawn without trails (their glow still shows). */
  trailOverflow: number;
  /** Per layer: its glow group (0..glowGroupCount-1), or -1. */
  glowGroup: number[];
  /** Per group: the index of its first layer (whose settings it uses). */
  glowLead: number[];
  glowGroupCount: number;
}

export function emptyPlan(): EffectsPlan {
  return { whole: -1, trails: [], trailCount: 0, trailOverflow: 0, glowGroup: [], glowLead: [], glowGroupCount: 0 };
}

export function emptyFxLayer(): FxLayer {
  return { object: null, glow: false, strength: 0, radius: 0, threshold: 0, trails: false, persistence: 0 };
}

function sameGlow(a: FxLayer, b: FxLayer): boolean {
  return a.glow === b.glow && (!a.glow || (a.strength === b.strength && a.radius === b.radius && a.threshold === b.threshold));
}

function sameSettings(a: FxLayer, b: FxLayer): boolean {
  return sameGlow(a, b) && a.trails === b.trails && (!a.trails || a.persistence === b.persistence);
}

/** True when any layer has an effect on (otherwise the caller skips the effects entirely). */
export function anyEffect(layers: readonly FxLayer[], count: number): boolean {
  for (let i = 0; i < count; i++) if (layers[i]!.glow || layers[i]!.trails) return true;
  return false;
}

/** Plan the frame for the first `count` entries of `layers`, into `out`. */
export function planEffects(layers: readonly FxLayer[], count: number, out: EffectsPlan): EffectsPlan {
  out.whole = -1;
  out.trailCount = 0;
  out.trailOverflow = 0;
  out.glowGroupCount = 0;
  if (count === 0 || !anyEffect(layers, count)) return out;

  let uniform = true;
  for (let i = 1; i < count && uniform; i++) uniform = sameSettings(layers[0]!, layers[i]!);
  if (uniform) {
    out.whole = 0;
    return out;
  }

  for (let i = 0; i < count; i++) {
    const l = layers[i]!;
    out.glowGroup[i] = -1;
    if (l.trails) {
      if (out.trailCount < MAX_TRAIL_LAYERS) {
        out.trails[out.trailCount++] = i;
        continue;
      }
      out.trailOverflow++; // still glows, below
    }
    if (!l.glow) continue;
    let g = 0;
    while (g < out.glowGroupCount && !sameGlow(layers[out.glowLead[g]!]!, l)) g++;
    if (g === out.glowGroupCount) out.glowLead[out.glowGroupCount++] = i;
    out.glowGroup[i] = g;
  }
  return out;
}
