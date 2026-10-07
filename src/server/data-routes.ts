import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { PROJECT_NAME_RE } from '../shared/project-schema.ts';
import type { Hub } from './hub.ts';
import type { Log } from './log.ts';
import { writeFileAtomic, type ProjectStore } from './projects.ts';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.json']);
const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const DEFAULT_TIME_ZONE = 'Pacific/Auckland';

/** A plain file name we are willing to store and serve: no paths, no hidden files. */
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('.') &&
    !/[/\\\0]/.test(name) &&
    name.trim() === name &&
    DATA_EXTENSIONS.has(extname(name).toLowerCase())
  );
}

/** Pick a name not already taken in `existing`: "rain.csv", "rain (2).csv", … */
export function uniqueFileName(wanted: string, existing: Set<string>): string {
  if (!existing.has(wanted)) return wanted;
  const ext = extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function randomId(): string {
  return `ds-${Math.random().toString(36).slice(2, 8)}`;
}

export async function registerDataRoutes(app: FastifyInstance, store: ProjectStore, hub: Hub, log: Log): Promise<void> {
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

  // Source files are served read-only; they are never modified after import.
  app.get<{ Params: { name: string; file: string } }>('/projects/:name/data/:file', async (req, reply) => {
    const { name, file } = req.params;
    if (!PROJECT_NAME_RE.test(name) || !isSafeFileName(file)) return reply.code(400).send({ error: 'bad path' });
    const path = join(store.dataDir(name), file);
    try {
      const s = await stat(path);
      if (!s.isFile()) return reply.code(404).send({ error: 'not found' });
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply
      .header('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('cache-control', 'no-cache')
      .send(createReadStream(path));
  });

  // Import: copy the uploaded file into the current project's data/ folder unchanged and
  // add a dataset entry for it.
  app.post<{ Params: { name: string } }>('/api/projects/:name/data', async (req, reply) => {
    const { name } = req.params;
    if (name !== hub.currentProject.name) {
      return reply.code(409).send({ error: `"${name}" is not the open project` });
    }
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no file in upload' });
    const original = part.filename.split(/[/\\]/).pop() ?? '';
    if (!isSafeFileName(original)) {
      part.file.resume();
      return reply.code(400).send({ error: `unsupported file name "${original}" (use .csv, .tsv, .txt or .json)` });
    }
    const bytes = await part.toBuffer();
    if (part.file.truncated) return reply.code(413).send({ error: 'file too large' });

    const dir = store.dataDir(name);
    await mkdir(dir, { recursive: true });
    const file = uniqueFileName(original, new Set(await readdir(dir)));
    // Bytes are written exactly as uploaded (no re-encoding), atomically.
    await writeFileAtomic(join(dir, file), bytes);

    const datasets = hub.currentProject.project.datasets;
    const dataset = { id: randomId(), file, label: file.replace(/\.[^.]+$/, ''), timeZone: DEFAULT_TIME_ZONE };
    const error = hub.applyPatch([{ op: 'set', path: ['project', 'datasets', datasets.length], value: dataset }], 'server');
    if (error) {
      log.error(`import of ${file} saved the file but could not add the dataset: ${error}`);
      return reply.code(500).send({ error });
    }
    log.info(`imported ${file} (${bytes.length} bytes) into "${name}" as ${dataset.id}`);
    return { dataset };
  });
}
