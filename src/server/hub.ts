import { readFile } from 'node:fs/promises';
import type { WebSocket } from 'ws';
import { applyOps, PatchError, type PatchOp } from '../shared/patch.ts';
import {
  defaultSession,
  PROJECT_NAME_RE,
  ProjectSchema,
  SessionSchema,
  type Project,
  type SyncDoc,
} from '../shared/project-schema.ts';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  parseClientMessage,
  type ClientMessage,
  type OutputStatus,
  type ProjectProblem,
  type Role,
  type ServerMessage,
} from '../shared/protocol.ts';
import type { Log } from './log.ts';
import { ProjectError, writeFileAtomic, type ProjectStore } from './projects.ts';

const SAVE_DEBOUNCE_MS = 500;
const DEMO_PROJECT = 'demo';

interface Client {
  socket: WebSocket;
  id: string;
  role: Role | null;
  lastSeen: number;
}

interface ServerState {
  lastProject?: string;
}

/**
 * Authoritative state and relay. Holds the open project plus live session state, applies
 * patches from control windows, broadcasts them, and autosaves (debounced, atomic).
 */
export class Hub {
  private rev = 0;
  private projectName = DEMO_PROJECT;
  private doc!: SyncDoc;
  private clients = new Set<Client>();
  private outputStatus = new Map<string, OutputStatus>();
  private problems: ProjectProblem[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribeLog: () => void;

  constructor(
    private store: ProjectStore,
    private log: Log,
    private stateFile: string,
  ) {
    this.unsubscribeLog = log.subscribe((entry) => this.broadcast({ t: 'log', entries: [entry] }, 'control'));
  }

  /** Open the last project (or create/open the demo project). */
  async init(): Promise<void> {
    const last = await this.readServerState();
    const candidates = [last.lastProject, DEMO_PROJECT, ...(await this.store.list())].filter(
      (n): n is string => typeof n === 'string' && PROJECT_NAME_RE.test(n),
    );
    for (const name of candidates) {
      if (!(await this.store.exists(name))) continue;
      if (await this.tryOpen(name)) break;
    }
    if (!this.doc) {
      // Nothing loadable: make a fresh project rather than run without state.
      let name = DEMO_PROJECT;
      for (let i = 2; await this.store.exists(name); i++) name = `${DEMO_PROJECT}-${i}`;
      const project = await this.store.create(name);
      this.setProject(name, project);
      await this.writeServerState();
      this.log.info(`created project "${name}"`);
    }
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
  }

  get currentProject(): { name: string; project: Project } {
    return { name: this.projectName, project: this.doc.project };
  }

  attach(socket: WebSocket): void {
    const client: Client = { socket, id: '', role: null, lastSeen: Date.now() };
    this.clients.add(client);
    socket.on('message', (data) => {
      client.lastSeen = Date.now();
      const msg = parseClientMessage(String(data));
      if (!msg) {
        this.log.warn('ignored malformed message from client');
        return;
      }
      try {
        void this.handle(client, msg).catch((err) => this.log.error(`handling ${msg.t}: ${String(err)}`));
      } catch (err) {
        this.log.error(`handling ${msg.t}: ${String(err)}`);
      }
    });
    socket.on('close', () => {
      this.clients.delete(client);
      if (client.role) this.log.info(`${client.role} ${client.id} disconnected`);
      if (client.role === 'output') {
        this.outputStatus.delete(client.id);
        this.broadcast({ t: 'outputStatus', clientId: client.id, status: null }, 'control');
      }
    });
    socket.on('error', (err) => this.log.warn(`socket error: ${err.message}`));
  }

  /**
   * Apply ops from any source (control windows, HTTP routes). Returns an error message
   * if rejected; the state is unchanged in that case.
   */
  applyPatch(ops: PatchOp[], origin: string): string | null {
    for (const op of ops) {
      if (op.path[0] !== 'project' && op.path[0] !== 'session') return 'patch paths must start with "project" or "session"';
      if (op.path.length < 2) return 'cannot replace the whole project or session';
    }
    let next: SyncDoc;
    try {
      next = applyOps(this.doc, ops);
    } catch (err) {
      return err instanceof PatchError ? err.message : String(err);
    }
    const p = ProjectSchema.safeParse(next.project);
    if (!p.success) return `invalid project after patch: ${p.error.issues[0]?.message ?? 'unknown'}`;
    const s = SessionSchema.safeParse(next.session);
    if (!s.success) return `invalid session after patch: ${s.error.issues[0]?.message ?? 'unknown'}`;
    if (next.project.name !== this.doc.project.name) return 'project name cannot be changed by patch';

    this.doc = next;
    this.rev++;
    this.broadcast({ t: 'patch', rev: this.rev, ops, origin });
    if (ops.some((op) => op.path[0] === 'project')) this.scheduleSave();
    return null;
  }

  private async handle(client: Client, msg: ClientMessage): Promise<void> {
    if (msg.t !== 'hello' && !client.role) return; // must introduce itself first
    switch (msg.t) {
      case 'hello': {
        client.id = msg.clientId;
        client.role = msg.role;
        this.log.info(`${msg.role} ${msg.clientId} connected${msg.rev !== undefined ? ` (cached rev ${msg.rev})` : ''}`);
        this.sendFull(client);
        if (msg.role === 'control') {
          this.send(client, { t: 'log', entries: this.log.recent() });
          await this.sendProjects(client);
          for (const [clientId, status] of this.outputStatus) this.send(client, { t: 'outputStatus', clientId, status });
        }
        return;
      }
      case 'pong':
        return;
      case 'requestFull':
        this.sendFull(client);
        return;
      case 'patch': {
        if (client.role !== 'control') return;
        const error = this.applyPatch(msg.ops, client.id);
        if (error) {
          this.log.warn(`rejected patch from ${client.id}: ${error}`);
          this.send(client, { t: 'error', message: error });
          this.sendFull(client);
        }
        return;
      }
      case 'openProject':
        if (client.role !== 'control') return;
        if (msg.name === this.projectName) return;
        await this.flushSave();
        if (await this.tryOpen(msg.name)) this.broadcastFull();
        else this.send(client, { t: 'error', message: `could not open "${msg.name}"` });
        await this.broadcastProjects();
        return;
      case 'createProject': {
        if (client.role !== 'control') return;
        try {
          const project = await this.store.create(msg.name);
          await this.flushSave();
          this.setProject(msg.name, project);
          await this.writeServerState();
          this.log.info(`created project "${msg.name}"`);
          this.broadcastFull();
        } catch (err) {
          const message = err instanceof ProjectError ? err.message : String(err);
          this.send(client, { t: 'error', message });
        }
        await this.broadcastProjects();
        return;
      }
      case 'status':
        if (client.role !== 'output') return;
        this.outputStatus.set(client.id, msg.status);
        this.broadcast({ t: 'outputStatus', clientId: client.id, status: msg.status }, 'control');
        return;
      case 'log':
        this.log.write(msg.level, client.role ?? 'client', msg.message);
        return;
    }
  }

  private async tryOpen(name: string): Promise<boolean> {
    try {
      const { project, warnings } = await this.store.load(name);
      this.problems = this.problems.filter((p) => p.project !== name);
      for (const w of warnings) {
        this.log.warn(`project "${name}": ${w}`);
        this.problems.push({ project: name, message: w });
      }
      this.setProject(name, project);
      await this.writeServerState();
      this.log.info(`opened project "${name}"`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(message);
      this.problems = this.problems.filter((p) => p.project !== name);
      this.problems.push({ project: name, message });
      return false;
    }
  }

  private setProject(name: string, project: Project): void {
    this.projectName = name;
    this.doc = { project, session: this.doc?.session ?? defaultSession() };
    this.rev++;
  }

  // ---- persistence -------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.queueSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private queueSave(): Promise<void> {
    const name = this.projectName;
    const project = this.doc.project;
    // Saves are serialised so two writes never race on the same temp/backup files.
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.store.save(name, project);
      } catch (err) {
        this.log.error(`autosave of "${name}" failed: ${String(err)}`);
      }
    });
    return this.saveChain;
  }

  /** Write any pending change now. Called before switching project and on shutdown. */
  async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.queueSave();
    }
    await this.saveChain;
  }

  private async readServerState(): Promise<ServerState> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'));
      return typeof raw === 'object' && raw !== null ? (raw as ServerState) : {};
    } catch {
      return {};
    }
  }

  private async writeServerState(): Promise<void> {
    try {
      await writeFileAtomic(this.stateFile, `${JSON.stringify({ lastProject: this.projectName }, null, 2)}\n`);
    } catch (err) {
      this.log.warn(`could not write server state: ${String(err)}`);
    }
  }

  // ---- messaging ----------------------------------------------------------------

  private send(client: Client, msg: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn(`send to ${client.id} failed: ${String(err)}`);
    }
  }

  private broadcast(msg: ServerMessage, role?: Role): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (!c.role || (role && c.role !== role)) continue;
      if (c.socket.readyState !== c.socket.OPEN) continue;
      try {
        c.socket.send(text);
      } catch {
        // closed mid-send; the close handler cleans up
      }
    }
  }

  private sendFull(client: Client): void {
    this.send(client, {
      t: 'full',
      rev: this.rev,
      projectName: this.projectName,
      project: this.doc.project,
      session: this.doc.session,
    });
  }

  private broadcastFull(): void {
    for (const c of this.clients) if (c.role) this.sendFull(c);
  }

  private async projectsMessage(): Promise<ServerMessage> {
    return { t: 'projects', names: await this.store.list(), current: this.projectName, problems: this.problems };
  }

  private async sendProjects(client: Client): Promise<void> {
    this.send(client, await this.projectsMessage());
  }

  async broadcastProjects(): Promise<void> {
    this.broadcast(await this.projectsMessage(), 'control');
  }

  private tick(): void {
    const now = Date.now();
    for (const c of this.clients) {
      if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.log.warn(`${c.role ?? 'client'} ${c.id} timed out`);
        c.socket.terminate();
        continue;
      }
      this.send(c, { t: 'ping' });
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribeLog();
    await this.flushSave();
    for (const c of this.clients) c.socket.close(1001, 'server shutting down');
  }
}
