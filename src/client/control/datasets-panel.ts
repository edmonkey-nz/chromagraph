import type { Column } from '../../data/columns.ts';
import { dataUrl, DatasetLoader, type LoadedFile } from '../../data/dataset-loader.ts';
import type { Cadence } from '../../data/gaps.ts';
import { applyRowFilter, filterKey } from '../../data/row-filter.ts';
import type { PatchOp } from '../../shared/patch.ts';
import { summarise, type DatasetSummary } from '../../shared/layer-defaults.ts';
import type { RowFilter } from '../../shared/layer-schema.ts';
import { DatasetSchema, type Dataset } from '../../shared/project-schema.ts';
import { TableViewer } from './table-viewer.ts';

interface Report {
  file: string;
  /** The "treat as missing" markers it was parsed with, joined (a change parses again). */
  missing: string;
  status: 'loading' | 'ok' | 'error';
  loaded?: LoadedFile;
  /** Built once when the parse finishes; its identity changes only when the file is reloaded. */
  summary?: DatasetSummary;
  /** Summaries of the rows layers' filters keep, by filter key (null: the filter can't run). */
  filtered?: Map<string, DatasetSummary | null>;
  error?: string;
}

const DAY_MS = 86_400_000;

type CreditField = 'source' | 'url' | 'attribution';

/** The credit inputs: field, label, placeholder and hover hint. */
const CREDIT_FIELDS: readonly [field: CreditField, label: string, placeholder: string, hint: string][] = [
  ['source', 'source', 'NIWA CliFlo', 'Where the data comes from, e.g. "NIWA CliFlo". Text layers show it with {@source} and {@credit}.'],
  ['url', 'link', 'https://cliflo.niwa.co.nz', 'A link to the data, e.g. "https://cliflo.niwa.co.nz", shown as typed. Text layers show it with {@url}.'],
  [
    'attribution',
    'attribution',
    '© NIWA, CC BY 4.0',
    'The credit or licence line the source asks for, e.g. "© NIWA, CC BY 4.0". Text layers show it with {@attribution} and {@credit}.',
  ],
];

/**
 * One dataset's card. The card and its credit inputs are kept across renders (only the head
 * and the report are rebuilt), so an echo or another window's change never takes the focus
 * or the text from an input being typed in.
 */
interface Card {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  credits: Record<CreditField, HTMLInputElement>;
  /** The "treat as missing" markers, comma-separated. */
  missing: HTMLInputElement;
  /** The row viewer, made the first time it is opened, and whether it is shown. */
  viewer: TableViewer | null;
  viewing: boolean;
}

/** Markers from a comma-separated box: trimmed, no blanks or repeats. */
function markersOf(text: string): string[] {
  return [...new Set(text.split(',').map((m) => m.trim()).filter((m) => m.length > 0))];
}

function timeZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['UTC', 'Pacific/Auckland'];
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-NZ', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatNumber(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString('en-NZ', { maximumFractionDigits: 3 }) : '—';
}

function formatTime(ms: number, timeZone: string): string {
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat('en-NZ', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatStep(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${(ms / 1000).toLocaleString('en-NZ')} s`;
}

function describeColumn(c: Column, timeZone: string, cadence: Cadence | undefined): [string, string, string] {
  if (c.empty) return ['empty', '—', '—'];
  switch (c.type) {
    case 'number':
      return ['number', formatNumber(c.min), formatNumber(c.max)];
    case 'time': {
      const extra = cadence
        ? ` · step ${formatStep(cadence.step)}, ${cadence.gaps.length} gap${cadence.gaps.length === 1 ? '' : 's'}` +
          (cadence.nonMonotonic ? `, ${cadence.nonMonotonic} out of order` : '')
        : '';
      return [`time${c.assumedUtc ? ' (no zone, read as UTC)' : ''}${extra}`, formatTime(c.min, timeZone), formatTime(c.max, timeZone)];
    }
    case 'category': {
      const shown = c.dictionary.slice(0, 6).join(', ');
      return [`category (${c.dictionary.length})`, shown + (c.dictionary.length > 6 ? ', …' : ''), ''];
    }
    case 'text':
      return ['text', '', ''];
  }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/**
 * Datasets section of the control window: import, per-file parse report, label, timezone
 * and credits (source, link, attribution) editing, removal. Reports are produced by the same worker parser the output uses.
 */
export class DatasetsPanel {
  private loader = new DatasetLoader();
  private reports = new Map<string, Report>();
  private datasets: readonly Dataset[] = [];
  private projectName = '';
  private zones = timeZones();
  private cards = new Map<string, Card>();

  /** Called whenever a dataset report finishes loading (or fails), after the panel re-renders. */
  onChange: (() => void) | null = null;

  constructor(
    private root: HTMLElement,
    private fileInput: HTMLInputElement,
    private sendPatch: (ops: PatchOp[]) => void,
    private showError: (message: string) => void,
  ) {
    fileInput.addEventListener('change', () => void this.upload());
  }

  /**
   * Column summary of a parsed dataset, or null while it is loading, failed or unknown. With a
   * row filter, the summary of the rows it keeps (null when it can't run or keeps none). The
   * same filter gives the same object until the file is reloaded.
   */
  summary(datasetId: string, filter: readonly RowFilter[] = []): DatasetSummary | null {
    const report = this.reports.get(datasetId);
    if (!report?.summary || filter.length === 0) return report?.summary ?? null;
    const key = filterKey(filter);
    report.filtered ??= new Map();
    let summary = report.filtered.get(key);
    if (summary === undefined) {
      summary = null;
      const loaded = report.loaded;
      if (loaded) {
        try {
          const view = applyRowFilter({ table: loaded.result.table, cadences: loaded.cadences, calendars: loaded.calendars }, filter);
          summary = summarise(view.table, view.cadences);
        } catch {
          // Reported by the output, which fails the layer with the reason.
        }
      }
      // Bounded: one entry per filter tried in this session, cleared when the file reloads.
      if (report.filtered.size > 64) report.filtered.clear();
      report.filtered.set(key, summary);
    }
    return summary;
  }

  update(projectName: string, datasets: readonly Dataset[]): void {
    if (projectName !== this.projectName) {
      this.reports.clear();
      this.cards.clear();
      this.projectName = projectName;
    }
    if (datasets === this.datasets) return;
    this.datasets = datasets;
    const ids = new Set(datasets.map((d) => d.id));
    for (const id of [...this.reports.keys()]) if (!ids.has(id)) this.reports.delete(id);
    for (const d of datasets) {
      const r = this.reports.get(d.id);
      if (!r || r.file !== d.file || r.missing !== d.missing.join('\u0000')) this.parse(d);
    }
    this.render();
  }

  private parse(d: Dataset): void {
    const report: Report = { file: d.file, missing: d.missing.join('\u0000'), status: 'loading' };
    this.reports.set(d.id, report);
    const project = this.projectName;
    this.loader
      .load(dataUrl(project, d.file), d.file, undefined, d.missing)
      .then((loaded) => {
        if (this.reports.get(d.id) !== report) return;
        report.status = 'ok';
        report.loaded = loaded;
        report.summary = summarise(loaded.result.table, loaded.cadences);
      })
      .catch((err: unknown) => {
        if (this.reports.get(d.id) !== report) return;
        report.status = 'error';
        report.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (this.reports.get(d.id) !== report) return;
        this.render();
        try {
          this.onChange?.();
        } catch (err) {
          console.error('datasets onChange handler failed', err);
        }
      });
  }

  private async upload(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    const body = new FormData();
    body.append('file', file, file.name);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(this.projectName)}/data`, { method: 'POST', body });
      if (!res.ok) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
        this.showError(`Import of ${file.name} failed: ${msg}`);
      }
    } catch (err) {
      this.showError(`Import of ${file.name} failed: ${String(err)}`);
    }
  }

  private render(): void {
    if (this.datasets.length === 0) {
      this.cards.clear();
      this.root.replaceChildren(h('div', { className: 'muted' }, 'No datasets yet. Import a CSV or JSON file.'));
      return;
    }
    const ids = new Set(this.datasets.map((d) => d.id));
    for (const id of [...this.cards.keys()]) if (!ids.has(id)) this.cards.delete(id);
    const els = this.datasets.map((d, i) => this.renderDataset(d, i));
    // Re-placing a card would blur an input in it, so only do it when the list changed.
    const kids = this.root.children;
    if (kids.length !== els.length || els.some((el, i) => kids[i] !== el)) this.root.replaceChildren(...els);
  }

  private card(d: Dataset): Card {
    const known = this.cards.get(d.id);
    if (known) return known;
    const head = h('div', { className: 'ds-head' });
    const body = h('div', { className: 'ds-body' });
    const grid = h('div', { className: 'ds-credits' });
    const credits = {} as Record<CreditField, HTMLInputElement>;
    for (const [field, label, placeholder, hint] of CREDIT_FIELDS) {
      credits[field] = this.creditInput(d.id, field, placeholder, hint);
      grid.append(h('label', { textContent: label, title: hint, htmlFor: credits[field].id }), credits[field]);
    }
    const missing = this.missingInput(d.id);
    grid.append(h('label', { textContent: 'treat as missing', title: missing.title, htmlFor: missing.id }), missing);
    const card: Card = { el: h('div', { className: 'dataset' }, head, grid, body), head, body, credits, missing, viewer: null, viewing: false };
    this.cards.set(d.id, card);
    return card;
  }

  /**
   * A credit text box. It sends on change (Enter or leaving the box), not per keystroke;
   * Escape puts back the project's value. Leaving it without a change also shows the
   * project's value, in case another window changed it meanwhile.
   */
  private creditInput(id: string, field: CreditField, placeholder: string, hint: string): HTMLInputElement {
    const max = DatasetSchema.shape[field].maxLength ?? 2000;
    const input = h('input', { type: 'text', placeholder, title: hint, maxLength: max, spellcheck: false, id: `ds-${field}-${id}` });
    let sent = false;
    const current = () => this.datasets.find((d) => d.id === id)?.[field] ?? '';
    input.addEventListener('focus', () => (sent = false));
    input.addEventListener('change', () => {
      sent = true;
      this.sendCredit(id, field, input.value);
    });
    input.addEventListener('blur', () => {
      // Its echo may have arrived while the box still had the focus (Enter).
      input.value = sent ? input.value.trim() : current();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      input.value = current();
      input.blur();
    });
    return input;
  }

  /**
   * The "treat as missing" box: markers separated by commas ("NA, -, .."). Sends on change, like
   * the credit boxes; the windows then parse the file again with them.
   */
  private missingInput(id: string): HTMLInputElement {
    const input = h('input', {
      type: 'text',
      placeholder: 'NA, -, ..',
      title:
        'Cell texts that mean "no value" in this file, separated by commas, e.g. NA, -, .. Those cells are read as missing (gaps), so one "NA" no longer turns a number column into text. Empty cells are always missing; the file is not changed, and the report below counts what each one blanked.',
      spellcheck: false,
      id: `ds-missing-${id}`,
    });
    let sent = false;
    const current = () => (this.datasets.find((d) => d.id === id)?.missing ?? []).join(', ');
    input.addEventListener('focus', () => (sent = false));
    input.addEventListener('change', () => {
      sent = true;
      this.sendMissing(id, markersOf(input.value));
    });
    input.addEventListener('blur', () => {
      input.value = sent ? markersOf(input.value).join(', ') : current();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      input.value = current();
      input.blur();
    });
    return input;
  }

  private sendMissing(id: string, markers: string[]): void {
    const index = this.datasets.findIndex((d) => d.id === id);
    const dataset = this.datasets[index];
    if (!dataset) return;
    if (markers.join('\u0000') === dataset.missing.join('\u0000')) return;
    const check = DatasetSchema.shape.missing.safeParse(markers);
    if (!check.success) {
      this.showError(`"Treat as missing" for "${dataset.label}" was not saved: ${check.error.issues[0]?.message ?? 'invalid'} (at most 20 markers of up to 40 characters).`);
      return;
    }
    this.sendPatch([{ op: 'set', path: ['project', 'datasets', index, 'missing'], value: markers }]);
  }

  /** Validate and send one credit field; the dataset's index is looked up now, by id. */
  private sendCredit(id: string, field: CreditField, raw: string): void {
    const index = this.datasets.findIndex((d) => d.id === id);
    const dataset = this.datasets[index];
    if (!dataset) return;
    const value = raw.trim();
    if (value === dataset[field]) return;
    const check = DatasetSchema.shape[field].safeParse(value);
    if (!check.success) {
      this.showError(`The ${field === 'url' ? 'link' : field} of "${dataset.label}" was not saved: ${check.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    this.sendPatch([{ op: 'set', path: ['project', 'datasets', index, field], value }]);
  }

  private renderDataset(d: Dataset, index: number): HTMLElement {
    const card = this.card(d);
    for (const [field] of CREDIT_FIELDS) {
      const input = card.credits[field];
      // Never overwrite the box being typed in; it sends its own value when left.
      if (document.activeElement !== input && input.value !== d[field]) input.value = d[field];
    }
    const markers = d.missing.join(', ');
    if (document.activeElement !== card.missing && card.missing.value !== markers) card.missing.value = markers;
    const report = this.reports.get(d.id);
    const path = (key: string) => ['project', 'datasets', index, key];

    const label = h('input', { value: d.label, size: 18, title: 'Label' });
    label.addEventListener('change', () => this.sendPatch([{ op: 'set', path: path('label'), value: label.value }]));

    const tz = h('select', { title: 'Display timezone (data stays in UTC)' });
    const zones = this.zones.includes(d.timeZone) ? this.zones : [d.timeZone, ...this.zones];
    tz.append(...zones.map((z) => h('option', { value: z, textContent: z, selected: z === d.timeZone })));
    tz.addEventListener('change', () => {
      if (isValidTimeZone(tz.value)) this.sendPatch([{ op: 'set', path: path('timeZone'), value: tz.value }]);
    });

    const remove = h('button', { textContent: 'Remove', title: 'Remove from the project (the file stays in data/)' });
    remove.addEventListener('click', () => {
      if (window.confirm(`Remove dataset "${d.label}" from the project? The file stays in data/.`)) {
        this.sendPatch([{ op: 'remove', path: ['project', 'datasets', index] }]);
      }
    });

    const { head, body } = card;
    const loaded = report?.status === 'ok' ? report.loaded : undefined;
    const view = h('button', { textContent: card.viewing ? 'Hide rows' : 'View rows', title: 'Browse the rows as parsed: sort by a column, go to a row' });
    view.disabled = !loaded;
    view.addEventListener('click', () => this.showRows(d, !card.viewing));
    head.replaceChildren(label, h('span', { className: 'muted' }, d.file), tz, view, remove);
    body.replaceChildren();

    if (!report || report.status === 'loading') {
      body.append(h('div', { className: 'muted' }, 'Parsing…'));
    } else if (report.status === 'error') {
      body.append(h('div', { className: 'error' }, `Could not load: ${report.error}`));
    } else if (report.loaded) {
      const { result, cadences, bytes, parseMs } = report.loaded;
      const { table, report: rep } = result;
      body.append(
        h(
          'div',
          { className: 'muted' },
          `${table.rowCount.toLocaleString('en-NZ')} rows · ${table.columns.length} columns · ` +
            `${(bytes / 1024).toFixed(0)} KB · parsed in ${parseMs.toFixed(0)} ms` +
            (rep.raggedRows ? ` · ${rep.raggedRows} ragged rows` : ''),
        ),
      );
      const t = h('table', { className: 'cols' });
      const hr = t.insertRow();
      for (const c of ['column', 'type', 'missing', 'min / values', 'max']) hr.append(h('th', { textContent: c }));
      for (const c of table.columns) {
        const [type, min, max] = describeColumn(c, d.timeZone, cadences[c.name]);
        const row = t.insertRow();
        for (const v of [c.name, type, `${c.nullCount.toLocaleString('en-NZ')}`, min, max]) row.insertCell().textContent = v;
        if (c.empty) row.className = 'muted';
      }
      body.append(t);
      if (rep.issues.length) {
        body.append(
          h(
            'ul',
            { className: 'issues' },
            ...rep.issues.map((iss) => {
              const li = h('li', { className: iss.severity === 'error' ? 'error' : 'warn' }, iss.message);
              // A mostly-numeric column read as text: offer its odd texts as missing markers.
              const offer = (iss.markers ?? []).filter((m) => !d.missing.includes(m));
              if (offer.length > 0) {
                const label = offer.map((m) => `"${m}"`).join(', ');
                const fix = h('button', { className: 'btn small', textContent: `Treat ${label} as missing`, title: 'Add to this dataset\u2019s "treat as missing" list, so the column reads as numbers with gaps there' });
                fix.addEventListener('click', () => this.sendMissing(d.id, [...d.missing, ...offer]));
                li.append(' ', fix);
              }
              const row = iss.row;
              if (row !== undefined) {
                const show = h('button', { className: 'link-btn', textContent: `show row ${row + 1}`, title: 'Open the rows and go to this one' });
                show.addEventListener('click', () => this.showRows(d, true, row));
                li.append(' ', show);
              }
              return li;
            }),
          ),
        );
      }
    }
    // The viewer is kept across renders (scroll position and sort stay put).
    if (card.viewing && loaded) {
      card.viewer ??= new TableViewer();
      card.viewer.setTable(loaded.result.table, d.timeZone);
      if (card.viewer.el.parentElement !== card.el) card.el.append(card.viewer.el);
    } else {
      card.viewer?.el.remove();
    }
    return card.el;
  }

  /** Open or close a dataset's row viewer, and go to data row `row` (0-based) when given. */
  private showRows(d: Dataset, open: boolean, row?: number): void {
    const card = this.cards.get(d.id);
    if (!card) return;
    card.viewing = open;
    this.render();
    if (open && row !== undefined) card.viewer?.goTo(row);
  }
}
