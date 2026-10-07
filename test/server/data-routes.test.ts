import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeFileName, registerDataRoutes, uniqueFileName } from '../../src/server/data-routes.ts';
import { Hub } from '../../src/server/hub.ts';
import { Log } from '../../src/server/log.ts';
import { ProjectStore } from '../../src/server/projects.ts';

describe('file name helpers', () => {
  it('accepts plain data file names only', () => {
    expect(isSafeFileName('rain.csv')).toBe(true);
    expect(isSafeFileName('Rain Daily (2).JSON')).toBe(true);
    for (const bad of ['', '.hidden.csv', '../x.csv', 'a/b.csv', 'a\\b.csv', 'x.exe', 'noext', ' padded.csv']) {
      expect(isSafeFileName(bad), bad).toBe(false);
    }
  });

  it('de-duplicates names', () => {
    expect(uniqueFileName('a.csv', new Set())).toBe('a.csv');
    expect(uniqueFileName('a.csv', new Set(['a.csv']))).toBe('a (2).csv');
    expect(uniqueFileName('a.csv', new Set(['a.csv', 'a (2).csv']))).toBe('a (3).csv');
  });
});

function multipart(fileName: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----dwtest';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('import and serve', () => {
  let root: string;
  let app: FastifyInstance;
  let hub: Hub;
  const fixture = new URL('../fixtures/3384__Rain__daily-sample1.csv', import.meta.url);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dw-routes-'));
    const log = new Log();
    log.subscribe(() => {});
    const store = new ProjectStore(join(root, 'projects'));
    hub = new Hub(store, log, join(root, 'server-state.json'));
    await hub.init();
    app = Fastify();
    await registerDataRoutes(app, store, hub, log);
  });

  afterEach(async () => {
    await hub.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('copies the file byte-for-byte, adds a dataset and serves it back', async () => {
    const bytes = await readFile(fixture);
    const res = await app.inject({ method: 'POST', url: '/api/projects/demo/data', ...multipart('rain.csv', bytes) });
    expect(res.statusCode).toBe(200);
    const { dataset } = res.json() as { dataset: { id: string; file: string; timeZone: string } };
    expect(dataset.file).toBe('rain.csv');
    expect(dataset.timeZone).toBe('Pacific/Auckland');
    expect(hub.currentProject.project.datasets).toHaveLength(1);
    expect(Buffer.compare(await readFile(join(root, 'projects/demo/data/rain.csv')), bytes)).toBe(0);

    const again = await app.inject({ method: 'POST', url: '/api/projects/demo/data', ...multipart('rain.csv', bytes) });
    expect((again.json() as { dataset: { file: string } }).dataset.file).toBe('rain (2).csv');

    const served = await app.inject({ method: 'GET', url: '/projects/demo/data/rain.csv' });
    expect(served.statusCode).toBe(200);
    expect(Buffer.compare(served.rawPayload, bytes)).toBe(0);
  });

  it('rejects unsupported files and other projects', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/projects/demo/data', ...multipart('run.sh', Buffer.from('x')) });
    expect(bad.statusCode).toBe(400);
    const other = await app.inject({ method: 'POST', url: '/api/projects/other/data', ...multipart('a.csv', Buffer.from('a\n1')) });
    expect(other.statusCode).toBe(409);
    expect(hub.currentProject.project.datasets).toHaveLength(0);
  });

  it('refuses to serve paths outside data/', async () => {
    for (const url of ['/projects/demo/data/..%2Fproject.json', '/projects/demo/data/project.json', '/projects/..%2F..%2Fetc/data/passwd.csv']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });
});
