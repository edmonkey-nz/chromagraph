import type { FolderApi } from 'tweakpane';
import type { LayerConfig, TextLayer } from '../../shared/layer-schema.ts';
import { addFitButton, addIdentity, addOpacityBlend, addVec3, buildEffects, buildTransform, FONT_TITLES, type LayerUi, options } from './layer-ui.ts';

/** Text folders: General (template and row), Look, Transform. */

const MAX_TEXT = 2000;
/** Typing in the template sends at most this often (and always on blur). */
const TYPE_SEND_MS = 300;

export function buildText(ui: LayerUi, layer: TextLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf, true);
  addTemplate(ui, g, layer);
  ui.mark(
    g.addBinding({ row: layer.row }, 'row', { label: 'row', min: 0, max: 1, step: 0.0001 }).on('change', (ev) => ui.set(['row'], ev.value)),
    'row',
    'row',
  ).element.title = 'Current row, 0..1 of the row count; a 0 → 1 ramp on it follows the data playhead (Modulation → Data playhead)';

  const k = ui.folder(root, 'Look', 'Look', false);
  const m = {
    fontSize: layer.fontSize,
    colour: layer.colour,
    align: layer.align,
    anchorX: layer.anchorX,
    anchorY: layer.anchorY,
    maxWidth: layer.maxWidth,
    lineHeight: layer.lineHeight,
    letterSpacing: layer.letterSpacing,
    outlineWidth: layer.outlineWidth,
    outlineColour: layer.outlineColour,
    font: layer.font === 'terminal' || layer.font === 'sans' ? '' : layer.font,
    fontChoice: layer.font === 'terminal' || layer.font === 'sans' ? layer.font : 'custom',
    uppercase: layer.uppercase,
  };
  addVec3(ui, k, layer.position, 'position', ['position'], 'position').element.title = 'Anchor point in px (y up)';
  ui.mark(
    k.addBinding(m, 'fontSize', { label: 'font size', min: 8, max: 300, step: 1 }).on('change', (ev) => ui.set(['fontSize'], clamp(ev.value, 8, 400))),
    'font size',
    'fontSize',
  ).element.title = 'px at 1080p; 24 is the minimum that reads well when projected';
  k.addBinding(m, 'colour').on('change', (ev) => ui.set(['colour'], ev.value));
  addOpacityBlend(ui, k, layer);
  k.addBinding(m, 'align', { options: options(['left', 'center', 'right'] as const) }).on('change', (ev) => ui.set(['align'], ev.value));
  k.addBinding(m, 'anchorX', { label: 'anchor x', options: options(['left', 'center', 'right'] as const) }).on('change', (ev) =>
    ui.set(['anchorX'], ev.value),
  );
  k.addBinding(m, 'anchorY', { label: 'anchor y', options: options(['top', 'middle', 'bottom'] as const) }).on('change', (ev) =>
    ui.set(['anchorY'], ev.value),
  );
  ui.mark(
    k.addBinding(m, 'maxWidth', { label: 'wrap width', min: 0, max: 1920, step: 1 }).on('change', (ev) => ui.set(['maxWidth'], Math.max(0, ev.value))),
    'wrap width',
    'maxWidth',
  ).element.title = 'px; 0 = no wrapping';
  ui.mark(
    k.addBinding(m, 'lineHeight', { label: 'line height', min: 0.5, max: 3, step: 0.05 }).on('change', (ev) => ui.set(['lineHeight'], clamp(ev.value, 0.5, 3))),
    'line height',
    'lineHeight',
  );
  ui.mark(
    k.addBinding(m, 'letterSpacing', { label: 'letter spacing', min: -0.5, max: 2, step: 0.01 }).on('change', (ev) =>
      ui.set(['letterSpacing'], clamp(ev.value, -0.5, 2)),
    ),
    'letter spacing',
    'letterSpacing',
  );
  ui.mark(
    k.addBinding(m, 'outlineWidth', { label: 'outline', min: 0, max: 20, step: 0.5 }).on('change', (ev) => ui.set(['outlineWidth'], clamp(ev.value, 0, 20))),
    'outline',
    'outlineWidth',
  );
  k.addBinding(m, 'outlineColour', { label: 'outline colour' }).on('change', (ev) => ui.set(['outlineColour'], ev.value));
  const choice = k.addBinding(m, 'fontChoice', {
    label: 'font',
    options: [
      { text: FONT_TITLES.terminal, value: 'terminal' },
      { text: FONT_TITLES.sans, value: 'sans' },
      { text: 'custom (URL)', value: 'custom' },
    ],
  });
  const fontUrlApi = k.addBinding(m, 'font', { label: 'font URL' });
  fontUrlApi.element.title = 'URL of a .ttf, .otf or .woff font served by the app';
  fontUrlApi.hidden = m.fontChoice !== 'custom';
  choice.on('change', (ev) => {
    fontUrlApi.hidden = ev.value !== 'custom';
    if (ev.value !== 'custom') ui.set(['font'], ev.value);
    else if (m.font.trim()) ui.set(['font'], m.font.trim());
  });
  fontUrlApi.on('change', (ev) => {
    const url = ev.value.trim();
    if (url) ui.set(['font'], url);
  });
  k.addBinding(m, 'uppercase').on('change', (ev) => ui.set(['uppercase'], ev.value)).element.title = 'Show the text in capitals (the template is kept as written)';
  addFitButton(ui, k);

  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The template as a multi-line text box. Tweakpane's string binding is single-line, so its
 * input is swapped for a textarea (same styling) that sends while typing (throttled) and on
 * blur. An "insert column" list adds {Column} placeholders.
 */
function addTemplate(ui: LayerUi, f: FolderApi, layer: TextLayer): void {
  const m = { text: layer.text, insert: '' };
  const api = f.addBinding(m, 'text', { label: 'text' });
  const input = api.element.querySelector('input');
  const send = (value: string) => {
    if (value.length > MAX_TEXT) return;
    m.text = value;
    ui.set(['text'], value);
  };
  if (!input) {
    api.on('change', (ev) => send(ev.value));
  } else {
    const ta = document.createElement('textarea');
    ta.className = input.className;
    ta.value = layer.text;
    ta.rows = 3;
    ta.maxLength = MAX_TEXT;
    ta.spellcheck = false;
    ta.title = '{Column} shows that column at the current row; {Column|format} formats it, e.g. {Date|date} or {Rain [mm]|fixed:1}';
    Object.assign(ta.style, { height: 'auto', minHeight: '54px', resize: 'vertical', whiteSpace: 'pre-wrap', paddingTop: '2px', lineHeight: '1.4' });
    input.replaceWith(ta);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (ta.value !== m.text) send(ta.value);
    };
    ta.addEventListener('input', () => {
      if (timer === null) timer = setTimeout(flush, TYPE_SEND_MS);
    });
    ta.addEventListener('change', flush);
    ta.addEventListener('blur', flush);
    // Keep Tweakpane's key handling (and the W/E/R gizmo keys) out of the text box.
    ta.addEventListener('keydown', (ev) => ev.stopPropagation());
    insertColumn(ui, f, m, (text) => {
      ta.value = text;
      send(text);
    });
    return;
  }
  insertColumn(ui, f, m, (text) => {
    send(text);
    ui.quiet(() => api.refresh());
  });
}

function insertColumn(ui: LayerUi, f: FolderApi, m: { text: string; insert: string }, apply: (text: string) => void): void {
  if (!ui.summary) return;
  const cols = ui.summary.columns.filter((c) => !c.empty && !/[{}|]/.test(c.name));
  if (cols.length === 0) return;
  const list = f.addBinding(m, 'insert', {
    label: 'insert column',
    options: [{ text: '…', value: '' }, ...cols.map((c) => ({ text: c.name, value: `{${c.name}${c.type === 'time' ? '|date' : ''}}` }))],
  });
  list.on('change', (ev) => {
    if (ui.isQuiet() || !ev.value) return;
    const sep = m.text && !/\s$/.test(m.text) ? ' ' : '';
    apply(`${m.text}${sep}${ev.value}`);
    m.insert = '';
    ui.quiet(() => list.refresh());
  });
}
