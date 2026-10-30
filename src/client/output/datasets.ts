import type { CalendarFields } from '../../data/calendar.ts';
import type { Table } from '../../data/columns.ts';
import { dataUrl, DatasetLoader } from '../../data/dataset-loader.ts';
import type { Cadence } from '../../data/gaps.ts';
import type { Dataset } from '../../shared/project-schema.ts';

export interface LoadedDataset {
  table: Table;
  cadences: Record<string, Cadence>;
  /** Calendar fields per time column, in `timeZone`. */
  calendars: Record<string, CalendarFields>;
  timeZone: string;
  /** Bumped every time a new copy is swapped in, so layers know to rebuild. */
  version: number;
}

interface Entry {
  file: string;
  timeZone: string;
  /** "Treat as missing" markers the file was parsed with (joined, for comparison). */
  missing: string[];
  loaded: LoadedDataset | null;
  error: string | null;
  /** Bumped per load request so a stale response can be ignored. */
  token: number;
}

let versionCounter = 0;

/**
 * The output's parsed datasets, keyed by dataset id. Parsing (and calendar derivation in
 * the dataset's timezone) happens in the worker; this class only swaps finished results in.
 * A failed (re)load keeps the last good copy.
 */
export class DatasetStore {
  private loader = new DatasetLoader();
  private entries = new Map<string, Entry>();
  private projectName = '';
  private _errors: { id: string; message: string }[] = [];

  constructor(
    private log: (level: 'info' | 'warn' | 'error', message: string) => void,
    private onLoaded: (id: string, url: string) => void = () => {},
  ) {}

  get currentProject(): string {
    return this.projectName;
  }

  get errors(): readonly { id: string; message: string }[] {
    return this._errors;
  }

  get(id: string): LoadedDataset | null {
    return this.entries.get(id)?.loaded ?? null;
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
      if (!e || e.file !== d.file || e.timeZone !== d.timeZone || !sameList(e.missing, d.missing)) this.load(d.id, d.file, d.timeZone, d.missing);
    }
    this.refreshErrors();
  }

  /** Retry failed datasets (e.g. after the server comes back). */
  reloadFailed(): void {
    for (const [id, e] of this.entries) if (e.error) this.load(id, e.file, e.timeZone, e.missing);
  }

  private load(id: string, file: string, timeZone: string, missing: readonly string[]): void {
    const prev = this.entries.get(id);
    const entry: Entry = {
      missing: [...missing],
      file,
      timeZone,
      // Keep showing the previous copy of the same file while the new one loads.
      loaded: prev?.file === file ? prev.loaded : null,
      error: null,
      token: (prev?.token ?? 0) + 1,
    };
    this.entries.set(id, entry);
    const token = entry.token;
    const project = this.projectName;
    const url = dataUrl(project, file);
    this.loader
      .load(url, file, timeZone, missing)
      .then((loaded) => {
        const current = this.entries.get(id);
        if (!current || current.token !== token || this.projectName !== project) return;
        const fatal = loaded.result.report.issues.find((i) => i.severity === 'error');
        if (loaded.result.table.columns.length === 0) {
          current.error = fatal?.message ?? 'no columns';
          this.log('error', `dataset ${id} (${file}): ${current.error}`);
        } else {
          current.loaded = {
            table: loaded.result.table,
            cadences: loaded.cadences,
            calendars: loaded.calendars,
            timeZone,
            version: ++versionCounter,
          };
          current.error = null;
          this.log(
            'info',
            `dataset ${id} (${file}) loaded: ${loaded.result.table.rowCount} rows, ` +
              `${loaded.result.table.columns.length} columns, parsed in ${loaded.parseMs.toFixed(0)} ms`,
          );
          try {
            this.onLoaded(id, url);
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
        this.log('error', `dataset ${id} (${file}) failed to load${current.loaded ? '; keeping the previous copy' : ''}: ${current.error}`);
        this.refreshErrors();
      });
  }

  private refreshErrors(): void {
    this._errors = [...this.entries].filter(([, e]) => e.error).map(([id, e]) => ({ id, message: e.error! }));
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
