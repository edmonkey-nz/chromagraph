import type { Table } from '../../data/columns.ts';
import { dataUrl, DatasetLoader } from '../../data/dataset-loader.ts';
import type { Dataset } from '../../shared/project-schema.ts';

interface Entry {
  file: string;
  table: Table | null;
  error: string | null;
  /** Bumped per load request so a stale response can be ignored. */
  token: number;
}

/**
 * The output's parsed datasets, keyed by dataset id. Parsing happens in the worker; this
 * class only swaps finished tables in. A failed (re)load keeps the last good table.
 */
export class DatasetStore {
  private loader = new DatasetLoader();
  private entries = new Map<string, Entry>();
  private projectName = '';
  private _errors: { id: string; message: string }[] = [];

  constructor(
    private log: (level: 'info' | 'warn' | 'error', message: string) => void,
    private onLoaded: (id: string, table: Table, url: string) => void = () => {},
  ) {}

  get currentProject(): string {
    return this.projectName;
  }

  get errors(): readonly { id: string; message: string }[] {
    return this._errors;
  }

  get(id: string): Table | null {
    return this.entries.get(id)?.table ?? null;
  }

  /** Reconcile with the project's dataset list. Cheap when nothing changed. */
  sync(projectName: string, datasets: readonly Dataset[]): void {
    if (projectName !== this.projectName) {
      this.entries.clear();
      this.projectName = projectName;
    }
    const wanted = new Set(datasets.map((d) => d.id));
    for (const id of [...this.entries.keys()]) if (!wanted.has(id)) this.entries.delete(id);
    for (const d of datasets) {
      const e = this.entries.get(d.id);
      if (!e || e.file !== d.file) this.load(d.id, d.file);
    }
    this.refreshErrors();
  }

  /** Re-fetch every dataset (e.g. after the server comes back). Keeps tables meanwhile. */
  reloadFailed(): void {
    for (const [id, e] of this.entries) if (e.error) this.load(id, e.file);
  }

  private load(id: string, file: string): void {
    const prev = this.entries.get(id);
    const entry: Entry = { file, table: prev?.file === file ? prev.table : null, error: null, token: (prev?.token ?? 0) + 1 };
    this.entries.set(id, entry);
    const token = entry.token;
    const project = this.projectName;
    const url = dataUrl(project, file);
    this.loader
      .load(url, file)
      .then((loaded) => {
        const current = this.entries.get(id);
        if (!current || current.token !== token || this.projectName !== project) return;
        const fatal = loaded.result.report.issues.find((i) => i.severity === 'error');
        if (loaded.result.table.columns.length === 0) {
          current.error = fatal?.message ?? 'no columns';
          this.log('error', `dataset ${id} (${file}): ${current.error}`);
        } else {
          current.table = loaded.result.table;
          current.error = null;
          this.log(
            'info',
            `dataset ${id} (${file}) loaded: ${loaded.result.table.rowCount} rows, ` +
              `${loaded.result.table.columns.length} columns, parsed in ${loaded.parseMs.toFixed(0)} ms`,
          );
          try {
            this.onLoaded(id, loaded.result.table, url);
          } catch (err) {
            this.log('error', `dataset ${id}: consumer failed: ${String(err)}`);
          }
        }
        this.refreshErrors();
      })
      .catch((err: unknown) => {
        const current = this.entries.get(id);
        if (!current || current.token !== token) return;
        current.error = err instanceof Error ? err.message : String(err);
        this.log('error', `dataset ${id} (${file}) failed to load${current.table ? '; keeping the previous copy' : ''}: ${current.error}`);
        this.refreshErrors();
      });
  }

  private refreshErrors(): void {
    this._errors = [...this.entries].filter(([, e]) => e.error).map(([id, e]) => ({ id, message: e.error! }));
  }
}
