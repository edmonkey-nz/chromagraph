import type { LayerConfig, ReflectorLayer } from '../../shared/layer-schema.ts';
import { floorTransform } from '../../shared/layer-schema.ts';
import { diffChanges } from '../../shared/layer-helpers.ts';
import { addFitButton, addNumber, addOpacityBlend, addPair, buildEffects, buildTransform, type LayerUi } from './layer-ui.ts';

/**
 * Reflection plane folders: General (no dataset), Mirror, Transform. The plane is placed
 * with the layer transform (or the preview gizmo); "Lay flat as floor" puts it back along the
 * bottom of the frame.
 */
export function buildReflector(ui: LayerUi, layer: ReflectorLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const g = ui.folder(root, 'General', 'General', true);
  const m = { name: layer.name, enabled: layer.enabled, colour: layer.colour };
  g.addBinding(m, 'name').on('change', (ev) => {
    ui.set(['name'], ev.value);
    ui.entry.retitle(titleOf({ ...ui.entry.layer, name: ev.value }));
  });
  g.addBinding(m, 'enabled').on('change', (ev) => {
    ui.set(['enabled'], ev.value);
    ui.entry.retitle(titleOf({ ...ui.entry.layer, enabled: ev.value }));
  });
  const note = g.addBlade({
    view: 'text',
    label: '',
    parse: (v: string) => v,
    value: 'Reflects with the 3D camera only.',
    disabled: true,
  });
  note.element.title = 'With the 2D camera, or fixed to the screen, the plane shows its colour alone';

  const k = ui.folder(root, 'Mirror', 'Mirror', true);
  addNumber(ui, k, layer.reflectivity, 'reflectivity', ['reflectivity'], {
    min: 0,
    max: 1,
    step: 0.01,
    field: 'reflectivity',
    hint: 'How strongly the mirrored scene shows over the plane colour: 0 = plain plane, 1 = a perfect mirror',
  });
  addNumber(ui, k, layer.blur, 'blur', ['blur'], {
    min: 0,
    max: 1,
    step: 0.01,
    field: 'blur',
    hint: 'Roughness: 0 = a sharp mirror, 1 = a soft glossy smear',
  });
  addNumber(ui, k, layer.fade, 'fade (px)', ['fade'], {
    min: 0,
    max: 2000,
    step: 1,
    hardMax: Infinity,
    field: 'fade',
    hint: 'The reflection fades out over this distance from the plane, like a wet floor; 0 = no fade',
  });
  k.addBinding(m, 'colour').on('change', (ev) => ui.set(['colour'], ev.value)).element.title = 'The plane’s own colour, where nothing is reflected';
  addOpacityBlend(ui, k, layer);
  addPair(ui, k, layer.size, ['width', 'depth'], ['size'], {
    hardMin: 0,
    field: 'size',
    hint: 'px, before the transform (the plane is centred on the frame centre)',
  });
  addFitButton(ui, k);
  k.addButton({ title: 'Lay flat as floor' }).on('click', () => ui.send(diffChanges(ui.entry.layer.transform, floorTransform(), ['transform']))).element.title =
    'Lie flat (rotate x -90) along the bottom of the frame';

  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}
