import type { Column } from '../../data/columns.ts';
import { dataUrl, DatasetLoader, type LoadedFile } from '../../data/dataset-loader.ts';
import type { Cadence } from '../../data/gaps.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { Dataset } from '../../shared/project-schema.ts';

interface Report {
  file: string;
  status: 'loading' | 'ok' | 'error';
  loaded?: LoadedFile;
  error?: string;
}

const DAY_MS = 86_400_000;

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
 * Datasets section of the control window: import, per-file parse report, label and
 * timezone editing, removal. Reports are produced by the same worker parser the output uses.
 */
export class DatasetsPanel {
  private loader = new DatasetLoader();
  private reports = new Map<string, Report>();
  private datasets: readonly Dataset[] = [];
  private projectName = '';
  private zones = timeZones();

  constructor(
    private root: HTMLElement,
    private fileInput: HTMLInputElement,
    private sendPatch: (ops: PatchOp[]) => void,
    private showError: (message: string) => void,
  ) {
    fileInput.addEventListener('change', () => void this.upload());
  }

  update(projectName: string, datasets: readonly Dataset[]): void {
    if (projectName !== this.projectName) {
      this.reports.clear();
      this.projectName = projectName;
    }
    if (datasets === this.datasets) return;
    this.datasets = datasets;
    const ids = new Set(datasets.map((d) => d.id));
    for (const id of [...this.reports.keys()]) if (!ids.has(id)) this.reports.delete(id);
    for (const d of datasets) {
      const r = this.reports.get(d.id);
      if (!r || r.file !== d.file) this.parse(d);
    }
    this.render();
  }

  private parse(d: Dataset): void {
    const report: Report = { file: d.file, status: 'loading' };
    this.reports.set(d.id, report);
    const project = this.projectName;
    this.loader
      .load(dataUrl(project, d.file), d.file)
      .then((loaded) => {
        if (this.reports.get(d.id) !== report) return;
        report.status = 'ok';
        report.loaded = loaded;
      })
      .catch((err: unknown) => {
        if (this.reports.get(d.id) !== report) return;
        report.status = 'error';
        report.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => this.render());
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
      this.root.replaceChildren(h('div', { className: 'muted' }, 'No datasets yet. Import a CSV or JSON file.'));
      return;
    }
    this.root.replaceChildren(...this.datasets.map((d, i) => this.renderDataset(d, i)));
  }

  private renderDataset(d: Dataset, index: number): HTMLElement {
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

    const head = h('div', { className: 'ds-head' }, label, h('span', { className: 'muted' }, d.file), tz, remove);
    const body = h('div', { className: 'ds-body' });

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
          h('ul', { className: 'issues' }, ...rep.issues.map((iss) => h('li', { className: iss.severity === 'error' ? 'error' : 'warn' }, iss.message))),
        );
      }
    }
    return h('div', { className: 'dataset' }, head, body);
  }
}
