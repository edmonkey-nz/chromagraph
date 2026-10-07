import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileStore } from '../../src/server/profiles.ts';
import { defaultProfile, OutputProfileSchema } from '../../src/shared/output-profile.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-profiles-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ProfileStore', () => {
  it('saves, lists and loads profiles', async () => {
    const store = new ProfileStore(root);
    const p = { ...defaultProfile('hall'), corners: [[0.1, 0], [1, 0], [1, 1], [0, 1]] as const };
    await store.save(OutputProfileSchema.parse(p));
    expect(await store.list()).toEqual(['hall']);
    const { profile, warning } = await store.load('hall');
    expect(warning).toBeNull();
    expect(profile.corners[0]).toEqual([0.1, 0]);
  });

  it('falls back to .bak, then to an uncalibrated default, with a warning', async () => {
    const store = new ProfileStore(root);
    await store.save(defaultProfile('hall'));
    await store.save({ ...defaultProfile('hall'), corners: [[0.2, 0], [1, 0], [1, 1], [0, 1]] });
    await writeFile(join(root, 'hall.json'), '{ broken');
    const fromBak = await store.load('hall');
    expect(fromBak.warning).toMatch(/\.bak/);
    expect(fromBak.profile.corners[0]).toEqual([0, 0]);
    const missing = await store.load('nowhere');
    expect(missing.warning).toMatch(/default/);
    expect(missing.profile.name).toBe('nowhere');
  });

  it('the checked-in default profile is valid', async () => {
    const text = await readFile(new URL('../../output-profiles/default.json', import.meta.url), 'utf8');
    expect(OutputProfileSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});
