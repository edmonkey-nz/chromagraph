import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readdir, readFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { chromeLaunch, isOutputBrowser, parseMonitors, pickProjector, type LaunchMode, type Monitor } from './launch-args.ts';
import type { Log } from './log.ts';

/**
 * Starts and closes the output window's Chrome for the control window's header buttons.
 *
 * The output Chrome gets its own profile, so it is a separate instance from the Chrome the
 * control window runs in, and it is detached so a server restart leaves it running.
 */

const PROFILE_DIR = join(homedir(), '.config', 'chromagraph-output');
/** The profile's folder before the app was renamed to chromagraph: moved to PROFILE_DIR on the next launch. */
const LEGACY_PROFILE_DIR = join(homedir(), '.config', 'data-wrangler-output');
const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const CLOSE_WAIT_MS = 4000;

export interface LaunchResult {
  monitor: Monitor | null;
  nvidia: boolean;
}

async function findChrome(): Promise<string | null> {
  if (process.env.CHROME) return process.env.CHROME;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of CHROME_NAMES) {
      const p = join(dir, name);
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** X11 (XWayland) display: Chrome runs under X11, so it needs one even on a Wayland desktop. */
function xEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
}

function listMonitors(): Promise<Monitor[]> {
  return new Promise((resolve) => {
    execFile('xrandr', ['--listmonitors'], { env: xEnv(), timeout: 3000 }, (err, stdout) => {
      resolve(err ? [] : parseMonitors(stdout));
    });
  });
}

/** Pids of output Chrome main processes (either profile folder), found through /proc. */
async function runningPids(): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (isOutputBrowser(cmdline, PROFILE_DIR) || isOutputBrowser(cmdline, LEGACY_PROFILE_DIR)) pids.push(Number(entry));
    } catch {
      // the process exited while we looked
    }
  }
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class OutputLauncher {
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private log: Log,
    private url: string,
  ) {}

  /** Runs one launch or close at a time, so a double click can't start two windows. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.busy.then(job, job);
    this.busy = next.catch(() => undefined);
    return next;
  }

  close(): Promise<number> {
    return this.serial(() => this.closeNow());
  }

  launch(mode: LaunchMode): Promise<LaunchResult> {
    return this.serial(async () => {
      // A second launch would only open a tab in the running instance with its old flags,
      // so close it first: "On projector" then also moves an open output to the projector.
      await this.closeNow();
      await this.moveLegacyProfile();
      const chrome = await findChrome();
      if (!chrome) throw new Error('Chrome not found (tried google-chrome and chromium; set CHROME to its path)');
      const monitor = mode === 'projector' ? pickProjector(await listMonitors()) : null;
      const nvidia = existsSync('/proc/driver/nvidia/version');
      const { args, env } = chromeLaunch({ mode, url: this.url, profileDir: PROFILE_DIR, monitor, nvidia });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(chrome, args, { env: { ...xEnv(), ...env }, detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      const where = mode === 'window' ? 'in a window' : monitor ? `on ${monitor.name} at ${monitor.x},${monitor.y}` : 'full screen';
      this.log.info(`output window started ${where}${nvidia ? ' (NVIDIA PRIME offload)' : '; NVIDIA driver not loaded'}`, 'launcher');
      return { monitor, nvidia };
    });
  }

  /** Carry the output's Chrome profile over from its old folder (after closeNow, so it is not in use). */
  private async moveLegacyProfile(): Promise<void> {
    if (existsSync(PROFILE_DIR) || !existsSync(LEGACY_PROFILE_DIR)) return;
    try {
      await rename(LEGACY_PROFILE_DIR, PROFILE_DIR);
      this.log.info(`moved the output's Chrome profile to ${PROFILE_DIR}`, 'launcher');
    } catch (err) {
      this.log.warn(`could not move the old output profile (a new one is used): ${err instanceof Error ? err.message : String(err)}`, 'launcher');
    }
  }

  private async closeNow(): Promise<number> {
    const pids = await runningPids();
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    const until = Date.now() + CLOSE_WAIT_MS;
    while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    if (pids.length > 0) this.log.info('output window closed', 'launcher');
    return pids.length;
  }
}

export function registerLaunchRoutes(app: FastifyInstance, launcher: OutputLauncher, log: Log): void {
  // JSON bodies only: a plain form post from another site can't reach these (no CORS).
  app.post<{ Body: { mode: LaunchMode } }>(
    '/api/output/launch',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['projector', 'window'] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        return await launcher.launch(req.body.mode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`output window not started: ${message}`, 'launcher');
        return reply.code(500).send({ error: message });
      }
    },
  );
  app.post('/api/output/close', async () => ({ closed: await launcher.close() }));
}
