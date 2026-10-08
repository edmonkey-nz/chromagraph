import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hub } from '../../src/server/hub.ts';
import { Log } from '../../src/server/log.ts';
import { ProjectStore } from '../../src/server/projects.ts';
import type { ServerMessage } from '../../src/shared/protocol.ts';

/** Minimal stand-in for a ws WebSocket: records what the hub sends. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  /** Deliver a client message and let the hub's async handler finish. */
  async deliver(msg: unknown): Promise<void> {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

let root: string;
let store: ProjectStore;
let hub: Hub;
let ctl: FakeSocket;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-save-'));
  store = new ProjectStore(join(root, 'projects'));
  const log = new Log();
  log.subscribe(() => {});
  hub = new Hub(store, log, join(root, 'server-state.json'));
  await hub.init();
  ctl = new FakeSocket();
  hub.attach(ctl as never);
  await ctl.deliver({ t: 'hello', role: 'control', clientId: 'c1' });
});

afterEach(async () => {
  await hub.close();
  await rm(root, { recursive: true, force: true });
});

describe('save, Save As and snapshots', () => {
  it('confirms Save now with a saved message', async () => {
    await ctl.deliver({ t: 'saveNow' });
    expect(ctl.last('saved')?.project).toBe('demo');
  });

  it('Save As copies the project with its data and opens the copy', async () => {
    await ctl.deliver({ t: 'patch', ops: [{ op: 'set', path: ['project', 'output', 'background'], value: '#123456' }] });
    await ctl.deliver({ t: 'duplicateProject', name: 'gallery' });
    expect(hub.currentProject.name).toBe('gallery');
    expect(hub.currentProject.project.output.background).toBe('#123456');
    expect(ctl.last('full')?.projectName).toBe('gallery');
    const saved = JSON.parse(await readFile(join(root, 'projects/gallery/project.json'), 'utf8')) as { name: string };
    expect(saved.name).toBe('gallery');
    expect(await readdir(join(root, 'projects/gallery'))).toContain('data');
    // The original is untouched apart from the pending change being saved first.
    const original = JSON.parse(await readFile(join(root, 'projects/demo/project.json'), 'utf8')) as { output: { background: string } };
    expect(original.output.background).toBe('#123456');
    // Leftover staging folders never remain.
    expect((await readdir(join(root, 'projects'))).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('refuses Save As over an existing project', async () => {
    await ctl.deliver({ t: 'duplicateProject', name: 'demo' });
    expect(ctl.last('error')?.message).toMatch(/already exists/);
    expect(hub.currentProject.name).toBe('demo');
  });

  it('creates, restores (keeping a before-restore snapshot) and deletes snapshots', async () => {
    await ctl.deliver({ t: 'patch', ops: [{ op: 'set', path: ['project', 'output', 'background'], value: '#111111' }] });
    await ctl.deliver({ t: 'snapshotCreate', label: 'dark' });
    let list = ctl.last('snapshots')!.list;
    expect(list.map((s) => s.label)).toEqual(['dark']);

    await ctl.deliver({ t: 'patch', ops: [{ op: 'set', path: ['project', 'output', 'background'], value: '#eeeeee' }] });
    await ctl.deliver({ t: 'snapshotRestore', id: list[0]!.id });
    expect(hub.currentProject.project.output.background).toBe('#111111');
    expect(hub.currentProject.name).toBe('demo');
    list = ctl.last('snapshots')!.list;
    expect(list.map((s) => s.label).sort()).toEqual(['before restore', 'dark']);

    const dark = list.find((s) => s.label === 'dark')!;
    await ctl.deliver({ t: 'snapshotDelete', id: dark.id });
    expect(ctl.last('snapshots')!.list.map((s) => s.label)).toEqual(['before restore']);
  });

  it('rejects unsafe snapshot ids', async () => {
    await ctl.deliver({ t: 'snapshotRestore', id: '../../project' });
    expect(ctl.last('error')?.message).toMatch(/invalid snapshot id/);
  });
});
