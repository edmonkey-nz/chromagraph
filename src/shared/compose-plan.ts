/**
 * How the output draws its layers into the scene image when some layer needs more than one
 * plain draw: a drop shadow, a blur, or fixed to the screen (drawn with the 2D pixel camera
 * while the project camera is 3D). Pure; the output's Stage carries it out.
 *
 * Draw order is the difficulty: a shadow sits under its own layer but over the layers below,
 * a blurred layer stays in its slot, and a screen-fixed layer is drawn with another camera in
 * its slot. So the visible layers are sorted into stack order and cut into segments, drawn
 * one after another into the same scene target (the first clears it, the rest add to it):
 *
 *   plain  a run of layers drawn together in one render with one camera (the project
 *          camera, or the screen camera for a run of screen-fixed layers)
 *   image  one layer with a shadow and/or a blur: it is drawn alone into an offscreen image,
 *          then its shadow (the image's alpha, blurred, tinted, offset) is laid down, then
 *          the layer itself (plainly, or its blurred image instead)
 *
 * When no visible layer needs any of this (needsCompose false), the scene is drawn exactly
 * as before, in a single render: nothing here costs anything.
 *
 * Also here: the blur maths (gaussian sigma per pixel of the setting, which level of the
 * half-size pyramid to blur at) and the shadow offset in image coordinates.
 *
 * Plans are written into a reused object: no allocation per frame.
 */

/** The output image, in pixels (shadow offsets are in these). */
const OUTPUT_W = 1920;
const OUTPUT_H = 1080;

/** One visible layer (or other scene object) as the compositor sees it. */
export interface ComposeLayer {
  /** Opaque handle for the caller (the layer's scene object). */
  object: unknown;
  /** Stack position (the object's renderOrder); ties keep their scene order. */
  order: number;
  /** Drawn with the 2D screen camera rather than the project camera. */
  screen: boolean;
  /** Drop shadow on (enabled, with some opacity). */
  shadow: boolean;
  /** Blur on (enabled, with some amount). */
  blur: boolean;
}

export interface ComposeSegment {
  /** Range [start, end) of positions in the plan's `sorted` list. */
  start: number;
  end: number;
  screen: boolean;
  /** An image segment (always exactly one layer). */
  image: boolean;
}

export interface ComposePlan {
  /** Layer indices in stack order (bottom first); the first `count` are valid. */
  sorted: number[];
  count: number;
  segments: ComposeSegment[];
  segmentCount: number;
}

export function emptyComposePlan(): ComposePlan {
  return { sorted: [], count: 0, segments: [], segmentCount: 0 };
}

export function emptyComposeLayer(): ComposeLayer {
  return { object: null, order: 0, screen: false, shadow: false, blur: false };
}

/** True when some layer needs segmented drawing (otherwise the scene is one plain render). */
export function needsCompose(layers: readonly ComposeLayer[], count: number): boolean {
  for (let i = 0; i < count; i++) {
    const l = layers[i]!;
    if (l.screen || l.shadow || l.blur) return true;
  }
  return false;
}

/** Plan the first `count` entries of `layers` into `out`. */
export function planCompose(layers: readonly ComposeLayer[], count: number, out: ComposePlan): ComposePlan {
  // Stable insertion sort by order (a handful of layers; no allocation).
  const sorted = out.sorted;
  for (let i = 0; i < count; i++) {
    let j = i;
    const order = layers[i]!.order;
    while (j > 0 && layers[sorted[j - 1]!]!.order > order) {
      sorted[j] = sorted[j - 1]!;
      j--;
    }
    sorted[j] = i;
  }
  out.count = count;

  let n = 0;
  let current: ComposeSegment | null = null;
  for (let p = 0; p < count; p++) {
    const l = layers[sorted[p]!]!;
    const image = l.shadow || l.blur;
    if (!image && current && !current.image && current.screen === l.screen) {
      current.end = p + 1;
      continue;
    }
    current = out.segments[n] ??= { start: 0, end: 0, screen: false, image: false };
    n++;
    current.start = p;
    current.end = p + 1;
    current.screen = l.screen;
    current.image = image;
  }
  out.segmentCount = n;
  return out;
}

// ---- blur maths ---------------------------------------------------------------------

/** Gaussian sigma per pixel of a blur amount or shadow spread: the soft edge spans about the setting. */
export const SIGMA_PER_PX = 0.5;
/** Below this sigma (in image texels) a blur is invisible: drawn sharp. */
export const MIN_SIGMA = 0.35;
/** Largest sigma blurred at one pyramid level, in that level's texels (radius 3 sigma = 12 taps). */
export const MAX_LEVEL_SIGMA = 4;
export const MAX_TAPS = 12;
/** Pyramid levels (1: half size .. 4: a sixteenth); 100 px of blur needs level 4 at 1080p. */
export const MAX_LEVEL = 4;

export interface BlurStep {
  /** Pyramid level to blur at; 0 means no blur (use the sharp image). */
  level: number;
  /** Sigma still to apply at that level, in its texels (the downsampling already blurred a little). */
  sigma: number;
  /** Taps each side for that sigma (0: the level is used as it is). */
  taps: number;
}

export function emptyBlurStep(): BlurStep {
  return { level: 0, sigma: 0, taps: 0 };
}

/**
 * How to blur by `px` output pixels (a blur amount or shadow spread) when the image has
 * `scale` texels per output pixel (1 on the output, 0.5 in the preview). Each pyramid level
 * halves the size with a 2x2 box, which is itself a blur of variance (4^level - 1) / 12
 * image texels; the remainder is blurred at the chosen level.
 */
export function chooseBlur(px: number, scale: number, out: BlurStep): BlurStep {
  const sigma = Math.max(0, px) * SIGMA_PER_PX * Math.max(scale, 0);
  out.level = 0;
  out.sigma = 0;
  out.taps = 0;
  if (!(sigma >= MIN_SIGMA)) return out; // also NaN
  let level = 1;
  while (level < MAX_LEVEL && sigma / 2 ** level > MAX_LEVEL_SIGMA) level++;
  const size = 2 ** level;
  const prior = (size * size - 1) / 12;
  const rest = Math.sqrt(Math.max(0, sigma * sigma - prior)) / size;
  out.level = level;
  out.sigma = rest;
  out.taps = rest < 0.2 ? 0 : Math.min(MAX_TAPS, Math.ceil(rest * 3));
  return out;
}

/** True when a blur of `px` output pixels is visible at `scale` (otherwise it is drawn sharp). */
export function blurShows(px: number, scale: number): boolean {
  return px * SIGMA_PER_PX * scale >= MIN_SIGMA;
}

/** A shadow offset in output pixels (x right, y up) as an image uv offset, into `out`. */
export function offsetToUv(offset: readonly [number, number], out: { x: number; y: number }): { x: number; y: number } {
  out.x = Number.isFinite(offset[0]) ? offset[0] / OUTPUT_W : 0;
  out.y = Number.isFinite(offset[1]) ? offset[1] / OUTPUT_H : 0;
  return out;
}
