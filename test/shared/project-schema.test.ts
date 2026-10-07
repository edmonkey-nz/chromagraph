import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, defaultProject, migrate } from '../../src/shared/project-schema.ts';

describe('migrate', () => {
  it('accepts a current project unchanged', () => {
    const p = defaultProject('demo');
    const r = migrate(JSON.parse(JSON.stringify(p)));
    expect(r).toEqual({ ok: true, project: p, migratedFrom: null });
  });

  it('migrates every saved past-version fixture to the current schema', () => {
    // When the schema changes, save an example of the old version as vN.json here.
    const dir = new URL('../fixtures/projects/', import.meta.url);
    const files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = migrate(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
      expect(r.ok, `${f}: ${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) expect(r.project.version).toBe(CURRENT_VERSION);
    }
  });

  it('rejects missing, newer and invalid versions', () => {
    expect(migrate({ name: 'x' }).ok).toBe(false);
    expect(migrate({ ...defaultProject('x'), version: CURRENT_VERSION + 1 }).ok).toBe(false);
    expect(migrate({ ...defaultProject('x'), version: 0 }).ok).toBe(false);
    expect(migrate(null).ok).toBe(false);
    expect(migrate([]).ok).toBe(false);
  });

  it('reports schema errors instead of throwing', () => {
    const bad = { ...defaultProject('x'), output: { background: 'red' } };
    const r = migrate(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/colour/);
  });

  it('reports a failing migration step', () => {
    const r = migrate({ version: CURRENT_VERSION - 1 }, {
      [CURRENT_VERSION - 1]: () => {
        throw new Error('boom');
      },
    });
    expect(r.ok).toBe(false);
  });
});
