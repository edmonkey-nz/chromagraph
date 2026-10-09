import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyLayerTransform } from '../../src/client/output/layers/transform.ts';
import { defaultLayerOfType, fitAnyLayer } from '../../src/shared/layer-defaults.ts';
import { datasetSwitchChanges, edgePreset, LAYER_TYPE_TITLES } from '../../src/shared/layer-helpers.ts';
import { blankInstancerLayer, blankReflectorLayer, FRAME_CENTRE, LayerSchema } from '../../src/shared/layer-schema.ts';
import { playheadKind } from '../../src/shared/modulation-helpers.ts';
import { parameterDefs } from '../../src/shared/parameters.ts';
import { defaultProject, ProjectSchema } from '../../src/shared/project-schema.ts';

describe('reflection plane layer', () => {
  it('is a valid layer with no dataset', () => {
    const layer = blankReflectorLayer('r1', 'Floor');
    expect(LayerSchema.safeParse(layer).success).toBe(true);
    expect(layer.datasetId).toBeNull();
    expect(LAYER_TYPE_TITLES.reflector).toBe('reflection plane');
    const made = defaultLayerOfType('reflector', 'r2', 'Layer 2', null, null);
    expect(made.type).toBe('reflector');
  });

  it('lies flat along the bottom of the frame by default', () => {
    const layer = blankReflectorLayer('r1', 'Floor');
    const o = new Object3D();
    applyLayerTransform(o, layer.transform);
    o.updateMatrixWorld(true);
    // The plane is centred on the frame centre and faces +z before the transform.
    const centre = new Vector3(...FRAME_CENTRE).applyMatrix4(o.matrixWorld);
    expect(centre.x).toBeCloseTo(960, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
    const normal = new Vector3(0, 0, 1).transformDirection(o.matrixWorld);
    expect(normal.y).toBeCloseTo(1, 6);
    // Its far edge (top of the plane before the transform) goes back, away from the viewer.
    const far = new Vector3(FRAME_CENTRE[0], FRAME_CENTRE[1] + layer.size[1] / 2, 0).applyMatrix4(o.matrixWorld);
    expect(far.y).toBeCloseTo(0, 6);
    expect(far.z).toBeCloseTo(-540, 6);
  });

  it('fits to the frame without moving, and ignores dataset switches and the data playhead', () => {
    const layer = { ...blankReflectorLayer('r1', 'Floor'), size: [10, 10] as [number, number] };
    const fitted = fitAnyLayer(layer, null, 'UTC');
    expect(fitted.type === 'reflector' && fitted.size).toEqual([1920, 1080]);
    expect(fitted.transform).toEqual(layer.transform);
    expect(datasetSwitchChanges(layer, null, null)).toEqual([{ path: ['datasetId'], value: null }]);
    expect(playheadKind(layer)).toBeNull();
  });

  it('registers its modulatable numbers', () => {
    const project = defaultProject('p');
    project.layers.push(blankReflectorLayer('r1', 'Floor'));
    const ids = new Set(parameterDefs(project).map((d) => d.id));
    for (const id of ['reflectivity', 'blur', 'fade', 'size.0', 'size.1', 'opacity', 'transform.rotation.0']) expect(ids.has(`layer.r1.${id}`)).toBe(true);
    expect(ProjectSchema.safeParse(project).success).toBe(true);
  });
});

describe('box edge presets', () => {
  it('makes valid box layers', () => {
    const base = blankInstancerLayer('i1', 'Bars', 'd1');
    const outline = edgePreset(base, 'outline');
    expect(outline.primitive).toBe('box');
    expect(outline.edges).toMatchObject({ enabled: true, faceOpacity: 1, glow: 0 });
    expect(outline.effects.glow.enabled).toBe(false);
    const neon = edgePreset(base, 'neon');
    expect(neon.edges.faceOpacity).toBeLessThan(0.5);
    expect(neon.edges.glow).toBe(1);
    expect(neon.effects.glow.enabled).toBe(true);
    for (const l of [outline, neon]) expect(LayerSchema.safeParse(l).success).toBe(true);
    expect(base.primitive).toBe('bar'); // not mutated
  });
});
