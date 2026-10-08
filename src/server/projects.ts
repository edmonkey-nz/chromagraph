import { cp, link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultProject, migrate, PROJECT_NAME_RE, type Project } from '../shared/project-schema.ts';
import type { SnapshotInfo } from '../shared/protocol.ts';

let tmpCounter = 0;

function isNoEnt(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Crash-safe write: data goes to a temp file which is fsynced and renamed over the
 * target, so readers see either the old or the new file, never a partial one.
 *
 * With `backup`, the previous file is kept as `<path>.bak`. The backup is made by
 * hard-linking the old file and renaming the link into place, so it is atomic too and
 * no bytes are copied.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts: { backup?: boolean } = {},
): Promise<void> {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (opts.backup) {
      const bakTmp = `${path}.bak.${process.pid}.${tmpCounter++}.tmp`;
      try {
        await link(path, bakTmp);
        await rename(bakTmp, `${path}.bak`);
      } catch (err) {
        await unlink(bakTmp).catch(() => {});
        if (!isNoEnt(err)) throw err;
      }
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  // Persist the directory entry so the rename survives power loss.
  try {
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // directory fsync is best effort (not supported on every filesystem)
  }
}

export interface LoadedProject {
  project: Project;
  /** Non-fatal problems, e.g. "loaded from .bak because project.json was invalid". */
  warnings: string[];
}

export class ProjectError extends Error {}

export class ProjectStore {
  constructor(readonly root: string) {}

  dir(name: string): string {
    if (!PROJECT_NAME_RE.test(name)) throw new ProjectError(`invalid project name "${name}"`);
    return join(this.root, name);
  }

  dataDir(name: string): string {
    return join(this.dir(name), 'data');
  }

  private file(name: string): string {
    return join(this.dir(name), 'project.json');
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (isNoEnt(err)) return [];
      throw err;
    }
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !PROJECT_NAME_RE.test(e.name)) continue;
      const base = join(this.root, e.name, 'project.json');
      if ((await exists(base)) || (await exists(`${base}.bak`))) names.push(e.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  async exists(name: string): Promise<boolean> {
    const base = this.file(name);
    return (await exists(base)) || (await exists(`${base}.bak`));
  }

  async create(name: string): Promise<Project> {
    if (await this.exists(name)) throw new ProjectError(`project "${name}" already exists`);
    await mkdir(this.dataDir(name), { recursive: true });
    const project = defaultProject(name);
    await this.save(name, project);
    return project;
  }

  /** Load project.json, falling back to project.json.bak. Throws ProjectError if neither is usable. */
  async load(name: string): Promise<LoadedProject> {
    const base = this.file(name);
    const primary = await readProjectFile(base);
    if (primary.ok) {
      const warnings = primary.migratedFrom !== null ? [`migrated from version ${primary.migratedFrom}`] : [];
      return { project: primary.project, warnings };
    }
    const backup = await readProjectFile(`${base}.bak`);
    if (backup.ok) {
      // Move the bad file aside (kept for inspection) so the next save cannot rotate it
      // into project.json.bak over the good copy.
      let aside = '';
      if (primary.error !== 'file missing') {
        const asideName = `project.json.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          await rename(base, join(this.dir(name), asideName));
          aside = `; the bad file was kept as ${asideName}`;
        } catch {
          // leave it; the warning still reports the problem
        }
      }
      return {
        project: backup.project,
        warnings: [`project.json unusable (${primary.error}); loaded project.json.bak instead${aside}`],
      };
    }
    throw new ProjectError(`cannot load "${name}": ${primary.error}; backup: ${backup.error}`);
  }

  async save(name: string, project: Project): Promise<void> {
    await mkdir(this.dataDir(name), { recursive: true });
    await writeFileAtomic(this.file(name), `${JSON.stringify(project, null, 2)}\n`, { backup: true });
  }

  /**
   * Save As: copy `from` (its data files and snapshots, not its backups) to a new project
   * `to`, with `project` (the current state) as its project.json. Built in a temporary
   * folder and renamed into place, so a crash never leaves a half-copied project.
   */
  async duplicate(from: string, to: string, project: Project): Promise<Project> {
    if (await this.exists(to)) throw new ProjectError(`project "${to}" already exists`);
    const target = this.dir(to);
    const staging = join(this.root, `.${to}.${process.pid}.${tmpCounter++}.tmp`);
    try {
      await mkdir(staging, { recursive: true });
      await cp(this.dataDir(from), join(staging, 'data'), { recursive: true, errorOnExist: false });
      const snaps = join(this.dir(from), 'snapshots');
      if (await exists(snaps)) await cp(snaps, join(staging, 'snapshots'), { recursive: true });
      const copy: Project = { ...project, name: to };
      await writeFileAtomic(join(staging, 'project.json'), `${JSON.stringify(copy, null, 2)}\n`);
      await rename(staging, target);
      return copy;
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  // ---- snapshots: projects/<name>/snapshots/<id>.json = { label, createdAt, project } ----

  private snapshotDir(name: string): string {
    return join(this.dir(name), 'snapshots');
  }

  async createSnapshot(name: string, label: string, project: Project, now = Date.now()): Promise<SnapshotInfo> {
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    await mkdir(this.snapshotDir(name), { recursive: true });
    const body = { label, createdAt: now, project };
    await writeFileAtomic(join(this.snapshotDir(name), `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
    return { id, label, createdAt: now, layerCount: project.layers.length };
  }

  /** Snapshots newest first. Unreadable files are skipped (and left on disk for inspection). */
  async listSnapshots(name: string): Promise<SnapshotInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.snapshotDir(name));
    } catch {
      return [];
    }
    const out: SnapshotInfo[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || !SNAPSHOT_ID_RE.test(f.slice(0, -5))) continue;
      try {
        const body = JSON.parse(await readFile(join(this.snapshotDir(name), f), 'utf8')) as {
          label?: unknown;
          createdAt?: unknown;
          project?: { layers?: unknown[] };
        };
        out.push({
          id: f.slice(0, -5),
          label: typeof body.label === 'string' ? body.label : '',
          createdAt: typeof body.createdAt === 'number' ? body.createdAt : 0,
          layerCount: Array.isArray(body.project?.layers) ? body.project.layers.length : 0,
        });
      } catch {
        // skip unreadable snapshot
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** A snapshot's project, migrated and validated. Throws ProjectError if unusable. */
  async readSnapshot(name: string, id: string): Promise<Project> {
    if (!SNAPSHOT_ID_RE.test(id)) throw new ProjectError(`invalid snapshot id "${id}"`);
    let body: { project?: unknown };
    try {
      body = JSON.parse(await readFile(join(this.snapshotDir(name), `${id}.json`), 'utf8')) as { project?: unknown };
    } catch (err) {
      throw new ProjectError(`snapshot "${id}" cannot be read: ${isNoEnt(err) ? 'missing' : String(err)}`);
    }
    const r = migrate(body.project);
    if (!r.ok) throw new ProjectError(`snapshot "${id}" is not a usable project: ${r.error}`);
    return r.project;
  }

  async deleteSnapshot(name: string, id: string): Promise<void> {
    if (!SNAPSHOT_ID_RE.test(id)) throw new ProjectError(`invalid snapshot id "${id}"`);
    await unlink(join(this.snapshotDir(name), `${id}.json`));
  }
}

const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{1,8}$/;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type ReadResult = { ok: true; project: Project; migratedFrom: number | null } | { ok: false; error: string };

async function readProjectFile(path: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, error: isNoEnt(err) ? 'file missing' : String(err) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  return migrate(raw);
}
