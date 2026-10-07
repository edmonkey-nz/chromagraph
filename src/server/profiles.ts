import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultProfile, OutputProfileSchema, type OutputProfile } from '../shared/output-profile.ts';
import { PROJECT_NAME_RE } from '../shared/project-schema.ts';
import { ProjectError, writeFileAtomic } from './projects.ts';

/** output-profiles/<name>.json, saved atomically with a .bak like projects. */
export class ProfileStore {
  constructor(readonly root: string) {}

  private file(name: string): string {
    if (!PROJECT_NAME_RE.test(name)) throw new ProjectError(`invalid profile name "${name}"`);
    return join(this.root, `${name}.json`);
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.root);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((n) => PROJECT_NAME_RE.test(n))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /** Load a profile, falling back to its .bak, then to a fresh default (with a warning). */
  async load(name: string): Promise<{ profile: OutputProfile; warning: string | null }> {
    const base = this.file(name);
    for (const path of [base, `${base}.bak`]) {
      try {
        const parsed = OutputProfileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.success) {
          return { profile: parsed.data, warning: path === base ? null : `${name}.json unusable; loaded ${name}.json.bak` };
        }
      } catch {
        // missing or invalid JSON: try the next candidate
      }
    }
    return { profile: defaultProfile(name), warning: `profile "${name}" missing or invalid; using an uncalibrated default` };
  }

  async save(profile: OutputProfile): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFileAtomic(this.file(profile.name), `${JSON.stringify(profile, null, 2)}\n`, { backup: true });
  }
}
