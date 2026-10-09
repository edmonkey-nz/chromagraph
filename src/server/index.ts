import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerDataRoutes } from './data-routes.ts';
import { Hub } from './hub.ts';
import { OutputLauncher, registerLaunchRoutes } from './launcher.ts';
import { Log } from './log.ts';
import { ProjectStore } from './projects.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProd = process.env.NODE_ENV === 'production';

const log = new Log();
const store = new ProjectStore(resolve(ROOT, 'projects'));
const hub = new Hub(store, log, resolve(ROOT, 'server-state.json'));

process.on('uncaughtException', (err) => log.error(`uncaught: ${err.stack ?? String(err)}`));
process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${String(err)}`));

await hub.init();

const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });

app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));

await registerDataRoutes(app, store, hub, log);

// Header buttons in the control window start the output Chrome pointed at this server.
const launchHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
registerLaunchRoutes(app, new OutputLauncher(log, `http://${launchHost}:${PORT}/output/`), log);

app.get('/api/projects', async () => ({ names: await store.list(), current: hub.currentProject.name }));

// The About box (control window header) shows ABOUT.md, read on every request so edits show at once.
app.get('/api/about', async (_req, reply) => {
  const text = await readFile(resolve(ROOT, 'ABOUT.md'), 'utf8').catch(() => '');
  return reply.header('content-type', 'text/markdown; charset=utf-8').header('cache-control', 'no-cache').send(text);
});

for (const page of ['control', 'output'] as const) {
  app.get(`/${page}`, (_req, reply) => reply.redirect(`/${page}/`));
}
app.get('/', (_req, reply) => reply.redirect('/control/'));

if (isProd) {
  // Built bundle, no HMR: editing source can never reload a running output.
  await app.register(fastifyStatic, { root: resolve(ROOT, 'dist/client'), prefix: '/', wildcard: true });
  app.get('/output/sw.js', (_req, reply) =>
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(createReadStream(resolve(import.meta.dirname, 'static/output-sw.js'))),
  );
} else {
  const { default: middie } = await import('@fastify/middie');
  const { createServer } = await import('vite');
  await app.register(middie);
  const vite = await createServer({
    configFile: resolve(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
  });
  // Vite handles everything except the server's own routes and the bare-page redirects.
  const own = /^\/((ws|api|projects)(\/|$|\?)|(control|output)?($|\?))/;
  app.use((req, res, next) => {
    if (own.test(req.url ?? '')) next();
    else vite.middlewares(req, res, next);
  });
  app.addHook('onClose', async () => {
    await vite.close();
  });
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`${signal} received, saving and shutting down`);
  try {
    await hub.close();
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: PORT, host: HOST });
log.info(`${isProd ? 'production' : 'dev'} server on http://${HOST}:${PORT}  control: /control  output: /output`);
