import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hub } from '../../src/server/hub.ts';
import { Log } from '../../src/server/log.ts';
import { ProjectStore } from '../../src/server/projects.ts';
import type { ServerMessage } from '../../src/shared/protocol.ts';

/** Minimal stand-in for a ws WebSocket (as in save.test.ts). */
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
  async deliver(msg: unknown): Promise<void> {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

let root: string;
let hub: Hub;
let ctl: FakeSocket;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-switch-'));
  const store = new ProjectStore(join(root, 'projects'));
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

describe('switching project', () => {
  it('starts the playheads from zero, keeping play/pause', async () => {
    // Somewhere in the middle, paused, with a layer timeline and the camera clock moved on.
    await ctl.deliver({
      t: 'patch',
      ops: [
        { op: 'set', path: ['session', 'transport'], value: { playing: false, anchorWallMs: 1000, anchorPhase: 0.6 } },
        { op: 'set', path: ['session', 'layerTransports'], value: { 'ly-x': { playing: true, anchorWallMs: 1000, anchorPhase: 0.3 } } },
        { op: 'set', path: ['session', 'cameraClock'], value: { playing: true, anchorWallMs: 1000, anchorSeconds: 42 } },
      ],
    });
    await ctl.deliver({ t: 'createProject', name: 'other' });
    const before = Date.now();
    await ctl.deliver({ t: 'openProject', name: 'demo' });
    const full = ctl.last('full')!;
    expect(full.projectName).toBe('demo');
    const s = full.session;
    expect(s.transport.anchorPhase).toBe(0);
    expect(s.transport.playing).toBe(false);
    expect(s.transport.anchorWallMs).toBeGreaterThanOrEqual(before - 1000);
    expect(s.layerTransports).toEqual({});
    expect(s.cameraClock.anchorSeconds).toBe(0);
    expect(s.cameraClock.playing).toBe(true);
    expect(s.morph).toBeNull();
  });
});
