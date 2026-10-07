import * as chromatic from 'd3-scale-chromatic';
import { Color, DataTexture, LinearFilter, NearestFilter, RGBAFormat, SRGBColorSpace } from 'three';
import type { ColourRamp } from '../../../shared/layer-schema.ts';

const RAMP_SIZE = 256;

const INTERPOLATORS: Record<ColourRamp, (t: number) => string> = {
  viridis: chromatic.interpolateViridis,
  magma: chromatic.interpolateMagma,
  inferno: chromatic.interpolateInferno,
  plasma: chromatic.interpolatePlasma,
  cividis: chromatic.interpolateCividis,
  turbo: chromatic.interpolateTurbo,
  blues: chromatic.interpolateBlues,
  greens: chromatic.interpolateGreens,
  greys: chromatic.interpolateGreys,
  oranges: chromatic.interpolateOranges,
  reds: chromatic.interpolateReds,
  purples: chromatic.interpolatePurples,
  rdbu: chromatic.interpolateRdBu,
  spectral: chromatic.interpolateSpectral,
};

/** Categorical palette, sampled with nearest filtering at (code mod size + 0.5) / size. */
export const PALETTE = chromatic.schemeTableau10;

const cache = new Map<string, DataTexture>();

function makeTexture(colours: string[], filter: typeof LinearFilter | typeof NearestFilter): DataTexture {
  const data = new Uint8Array(colours.length * 4);
  const c = new Color();
  const rgb = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < colours.length; i++) {
    // Store sRGB bytes; the texture is tagged sRGB so sampling linearises them.
    c.setStyle(colours[i]!);
    c.getRGB(rgb, SRGBColorSpace);
    data[i * 4] = Math.round(rgb.r * 255);
    data[i * 4 + 1] = Math.round(rgb.g * 255);
    data[i * 4 + 2] = Math.round(rgb.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, colours.length, 1, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = filter;
  tex.minFilter = filter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Shared 256x1 ramp texture (tiny; kept for the life of the page). */
export function rampTexture(name: ColourRamp): DataTexture {
  let tex = cache.get(name);
  if (!tex) {
    const f = INTERPOLATORS[name] ?? chromatic.interpolateViridis;
    const colours: string[] = [];
    for (let i = 0; i < RAMP_SIZE; i++) colours.push(f(i / (RAMP_SIZE - 1)));
    tex = makeTexture(colours, LinearFilter);
    cache.set(name, tex);
  }
  return tex;
}

export function paletteTexture(): DataTexture {
  let tex = cache.get('__palette');
  if (!tex) {
    tex = makeTexture([...PALETTE], NearestFilter);
    cache.set('__palette', tex);
  }
  return tex;
}

/** After a WebGL context restore every cached texture must be uploaded again. */
export function invalidateRampTextures(): void {
  for (const tex of cache.values()) tex.needsUpdate = true;
}
