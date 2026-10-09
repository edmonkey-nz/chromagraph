import type { FolderApi } from 'tweakpane';
import { encodeQr, QR_MAX_BYTES, qrText, utf8Length, type QrLevel } from '../../data/qr-data.ts';
import { QR_CONTENTS, QR_LEVELS, type LayerConfig, type QrLayer } from '../../shared/layer-schema.ts';
import { addChoice, addIdentity, addNumber, addOpacityBlend, addPlain, addVec3, buildEffects, buildTransform, type LayerUi } from './layer-ui.ts';

/**
 * QR code folders: General (identity, what to encode), Code (error correction, margin,
 * colours), Placement (size and centre), then effects and Transform. A read-only line shows
 * the code's size in modules and how many px each module gets, or why nothing is shown.
 */

const MAX_TEXT = 2000;

const CONTENT_TITLES: Record<QrLayer['content'], string> = { text: 'text or URL', dataset: 'dataset link' };
const LEVEL_TITLES: Record<QrLevel, string> = {
  L: 'L: 7 % (smallest)',
  M: 'M: 15 %',
  Q: 'Q: 25 %',
  H: 'H: 30 % (sturdiest)',
};
const SCAN_HINT = 'Dark on light scans best; keep the margin at 4; on a wall aim for at least ~20 cm wide.';
const EFFECTS_HINT = 'Glow and blur soften the module edges and can stop the code scanning.';

export function buildQr(ui: LayerUi, layer: QrLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf, true);
  addChoice(ui, g, layer.content, 'encode', ['content'], QR_CONTENTS, CONTENT_TITLES).element.title =
    'Text or URL: what you type below. Dataset link: the url of the layer’s dataset (set in the Datasets tab), so the code follows the dataset’s credits';
  if (layer.content === 'text') addText(ui, g, layer);
  else addDatasetNote(ui, g, layer);
  addReadout(ui, g);

  const k = ui.folder(root, 'Code', 'Code', true);
  addChoice(ui, k, layer.level, 'error correction', ['level'], QR_LEVELS, LEVEL_TITLES).element.title =
    'How much of the code can be lost (dirt, glare, a logo) and still scan. Higher levels need more modules, so each is smaller at the same size; M suits most screens and walls';
  addNumber(ui, k, layer.margin, 'margin (modules)', ['margin'], {
    min: 0,
    max: 10,
    step: 1,
    integer: true,
    hint: 'The light quiet zone around the code, in modules. 4 is the standard; less may not scan',
  });
  addPlain(ui, k, layer.dark, 'dark', ['dark']).element.title = SCAN_HINT;
  addPlain(ui, k, layer.light, 'light', ['light']).element.title = `${SCAN_HINT} The light colour also fills the margin.`;
  addOpacityBlend(ui, k, layer);
  const tip = k.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: 'Scanning tips (hover)', disabled: true });
  tip.element.title = `${SCAN_HINT} ${EFFECTS_HINT}`;

  const p = ui.folder(root, 'Placement', 'Placement', true);
  addNumber(ui, p, layer.size, 'size (px)', ['size'], {
    min: 64,
    max: 1080,
    step: 1,
    hardMin: 16,
    hardMax: 2160,
    field: 'size',
    hint: `Width and height at 1080p, margin included. ${SCAN_HINT}`,
  });
  addVec3(ui, p, layer.position, 'centre', ['position'], 'position').element.title = 'Centre of the code in px (y up), before the transform';

  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

/** The text or URL to encode. Sends on Enter or leaving the box. */
function addText(ui: LayerUi, f: FolderApi, layer: QrLayer): void {
  const m = { text: layer.text };
  const api = f.addBinding(m, 'text', { label: 'text / URL' });
  api.element.title = 'What the code holds, e.g. https://example.org/more-info. Phones open a URL; other text is shown as text';
  const input = api.element.querySelector('input');
  if (input) {
    input.maxLength = MAX_TEXT;
    input.spellcheck = false;
    // Keep the W/E/R gizmo keys out of the text box.
    input.addEventListener('keydown', (ev) => ev.stopPropagation());
  }
  api.on('change', (ev) => {
    if (ev.value.length <= MAX_TEXT) ui.set(['text'], ev.value);
  });
}

/** Dataset mode: the link being encoded, or why there is none. */
function addDatasetNote(ui: LayerUi, f: FolderApi, layer: QrLayer): void {
  const dataset = ui.doc.project.datasets.find((d) => d.id === layer.datasetId);
  let text: string;
  let hint: string;
  if (!dataset) {
    text = 'No dataset chosen: nothing is shown.';
    hint = 'Choose the dataset whose link to encode (dataset, above)';
  } else if (dataset.url.trim() === '') {
    text = 'This dataset has no link yet: nothing is shown.';
    hint = `Set a url for “${dataset.label || dataset.file}” in the Datasets tab`;
  } else {
    text = dataset.url.trim();
    hint = `The link of “${dataset.label || dataset.file}” (edit it in the Datasets tab)`;
  }
  f.addBlade({ view: 'text', label: 'link', parse: (v: string) => v, value: text, disabled: true }).element.title = hint;
}

/** "33 × 33 modules, 7.6 px each", or what is wrong (on one line). */
function addReadout(ui: LayerUi, f: FolderApi): void {
  const m = { code: '' };
  const api = f.addBinding(m, 'code', { label: 'code', readonly: true, interval: 0 });
  api.element.title = `Modules across (margin included) and the px each gets at 1080p. ${SCAN_HINT}`;
  let encoded: { text: string | null; level: QrLevel; count: number; error: string | null } | null = null;
  const refresh = () => {
    const l = ui.entry.layer;
    if (l.type !== 'qr') return;
    const dataset = (ui.getDoc() ?? ui.doc).project.datasets.find((d) => d.id === l.datasetId);
    const text = qrText(l, dataset);
    if (!encoded || encoded.text !== text || encoded.level !== l.level) {
      encoded = { text, level: l.level, count: 0, error: null };
      const bytes = text === null ? 0 : utf8Length(text);
      if (bytes > QR_MAX_BYTES[l.level]) {
        // The output flags the layer with the full message.
        encoded.error = `too long: ${bytes} bytes, at most ${QR_MAX_BYTES[l.level]} at ${l.level}`;
      } else {
        try {
          if (text !== null) encoded.count = encodeQr(text, l.level).count;
        } catch (err) {
          encoded.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    let out: string;
    if (encoded.error) out = encoded.error;
    else if (text === null) out = 'nothing to encode';
    else {
      const side = encoded.count + 2 * l.margin;
      const px = l.size / side;
      out = `${side} × ${side} modules, ${px.toFixed(1)} px each${px < 3 ? ' (small)' : ''}`;
    }
    if (out !== m.code) {
      m.code = out;
      api.refresh();
    }
  };
  ui.entry.refreshReadout = refresh;
  refresh();
}
