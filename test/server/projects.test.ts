import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectError, ProjectStore, writeFileAtomic } from '../../src/server/projects.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-projects-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes, keeps the previous version as .bak, and leaves no temp files', async () => {
    const f = join(root, 'a.json');
    await writeFileAtomic(f, 'one', { backup: true });
    await writeFileAtomic(f, 'two', { backup: true });
    await writeFileAtomic(f, 'three', { backup: true });
    expect(await readFile(f, 'utf8')).toBe('three');
    expect(await readFile(`${f}.bak`, 'utf8')).toBe('two');
    expect((await readdir(root)).sort()).toEqual(['a.json', 'a.json.bak']);
  });

  it('leaves the original intact and cleans up when the write fails', async () => {
    const f = join(root, 'a.json');
    await writeFileAtomic(f, 'good');
    await expect(writeFileAtomic(join(root, 'missing-dir', 'x.json'), 'x')).rejects.toThrow();
    expect(await readFile(f, 'utf8')).toBe('good');
    expect(await readdir(root)).toEqual(['a.json']);
  });
});

describe('ProjectStore', () => {
  it('creates, lists, saves and loads', async () => {
    const store = new ProjectStore(root);
    const p = await store.create('rain');
    expect(await store.list()).toEqual(['rain']);
    await store.save('rain', { ...p, output: { ...p.output, background: '#112233' } });
    const loaded = await store.load('rain');
    expect(loaded.project.output.background).toBe('#112233');
    expect(loaded.warnings).toEqual([]);
    expect(await readdir(join(root, 'rain'))).toContain('data');
  });

  it('refuses duplicate and unsafe names', async () => {
    const store = new ProjectStore(root);
    await store.create('rain');
    await expect(store.create('rain')).rejects.toThrow(ProjectError);
    await expect(store.create('../escape')).rejects.toThrow(ProjectError);
    await expect(store.create('')).rejects.toThrow(ProjectError);
  });

  it('falls back to .bak when project.json is corrupt', async () => {
    const store = new ProjectStore(root);
    const p = await store.create('rain');
    await store.save('rain', { ...p, output: { ...p.output, background: '#445566' } });
    await writeFile(join(root, 'rain', 'project.json'), '{"version": 1, "name": "rain", trunc');
    const loaded = await store.load('rain');
    expect(loaded.project.output.background).toBe('#000000');
    expect(loaded.warnings[0]).toMatch(/\.bak/);

    // The next save must not rotate the corrupt file into .bak over the good copy.
    await store.save('rain', { ...loaded.project, output: { ...loaded.project.output, background: '#778899' } });
    const files = await readdir(join(root, 'rain'));
    expect(files.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'rain', 'project.json.bak'), 'utf8')).output.background).toBe('#000000');
  });

  it('throws a ProjectError when neither file is usable', async () => {
    const store = new ProjectStore(root);
    await store.create('rain');
    await writeFile(join(root, 'rain', 'project.json'), 'nope');
    await writeFile(join(root, 'rain', 'project.json.bak'), 'nope');
    await expect(store.load('rain')).rejects.toThrow(ProjectError);
  });
});
