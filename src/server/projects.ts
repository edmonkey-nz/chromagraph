import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultProject, migrate, PROJECT_NAME_RE, type Project } from '../shared/project-schema.ts';

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
export async function writeFileAtomic(path: string, data: string, opts: { backup?: boolean } = {}): Promise<void> {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
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
      return {
        project: backup.project,
        warnings: [`project.json unusable (${primary.error}); loaded project.json.bak instead`],
      };
    }
    throw new ProjectError(`cannot load "${name}": ${primary.error}; backup: ${backup.error}`);
  }

  async save(name: string, project: Project): Promise<void> {
    await mkdir(this.dataDir(name), { recursive: true });
    await writeFileAtomic(this.file(name), `${JSON.stringify(project, null, 2)}\n`, { backup: true });
  }
}

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
