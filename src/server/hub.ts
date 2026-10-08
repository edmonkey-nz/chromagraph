import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WebSocket } from 'ws';
import { defaultProfile, OutputProfileSchema, type OutputProfile } from '../shared/output-profile.ts';
import { applyOps, PatchError, type PatchOp } from '../shared/patch.ts';
import {
  defaultSession,
  PROJECT_NAME_RE,
  ProjectSchema,
  SessionSchema,
  type Project,
  type Session,
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
import { ProfileStore } from './profiles.ts';
import { ProjectError, writeFileAtomic, type ProjectStore } from './projects.ts';

const SAVE_DEBOUNCE_MS = 500;
const DEMO_PROJECT = 'demo';
const DEFAULT_PROFILE = 'default';

interface Client {
  socket: WebSocket;
  id: string;
  role: Role | null;
  lastSeen: number;
}

interface ServerState {
  lastProject?: string;
  lastProfile?: string;
  /** Live session (timeline transport, toggles), kept so a restart does not jump the playhead. */
  session?: unknown;
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
  private bootSession: Session | null = null;
  private bootProfile: OutputProfile | null = null;
  /** Last project that failed to open at start-up; stays in server-state until the user picks another. */
  private keepLastProject: string | null = null;
  private profileTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: ProjectStore,
    private log: Log,
    private stateFile: string,
    private profiles: ProfileStore = new ProfileStore(join(dirname(stateFile), 'output-profiles')),
  ) {
    this.unsubscribeLog = log.subscribe((entry) => this.broadcast({ t: 'log', entries: [entry] }, 'control'));
  }

  /** Open the last project (or create/open the demo project). */
  async init(): Promise<void> {
    const last = await this.readServerState();
    const saved = SessionSchema.safeParse(last.session);
    this.bootSession = saved.success ? saved.data : defaultSession(Date.now());
    const profileName = typeof last.lastProfile === 'string' && PROJECT_NAME_RE.test(last.lastProfile) ? last.lastProfile : DEFAULT_PROFILE;
    const { profile, warning } = await this.profiles.load(profileName);
    if (warning) {
      this.log.warn(warning);
      this.problems.push({ project: `profile ${profileName}`, message: warning });
    }
    this.bootProfile = profile;
    const candidates = [last.lastProject, DEMO_PROJECT, ...(await this.store.list())].filter(
      (n): n is string => typeof n === 'string' && PROJECT_NAME_RE.test(n),
    );
    const wanted = candidates[0] === last.lastProject ? last.lastProject : null;
    for (const name of candidates) {
      if (!(await this.store.exists(name))) continue;
      if (await this.tryOpen(name)) break;
      if (name === wanted) {
        // Keep remembering it: once the problem is fixed, the next start opens it again
        // instead of whatever fallback is shown meanwhile.
        this.keepLastProject = wanted;
        this.log.warn(`could not open the last project "${wanted}"; showing a fallback until it is fixed`);
      }
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

  get currentProfile(): OutputProfile {
    return this.doc.profile;
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
      if (op.path[0] !== 'project' && op.path[0] !== 'session' && op.path[0] !== 'profile') {
        return 'patch paths must start with "project", "session" or "profile"';
      }
      if (op.path.length < 2) return 'cannot replace the whole project, session or profile';
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
    const pr = OutputProfileSchema.safeParse(next.profile);
    if (!pr.success) return `invalid output profile after patch: ${pr.error.issues[0]?.message ?? 'unknown'}`;
    if (next.profile.name !== this.doc.profile.name) return 'profile name cannot be changed by patch';

    this.doc = next;
    this.rev++;
    this.broadcast({ t: 'patch', rev: this.rev, ops, origin });
    if (ops.some((op) => op.path[0] === 'project')) this.scheduleSave();
    if (ops.some((op) => op.path[0] === 'session')) this.scheduleStateWrite();
    if (ops.some((op) => op.path[0] === 'profile')) this.scheduleProfileSave();
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
          await this.sendSnapshots(client);
          await this.sendProfiles(client);
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
        this.keepLastProject = null;
        await this.flushSave();
        if (await this.tryOpen(msg.name)) this.broadcastFull();
        else this.send(client, { t: 'error', message: `could not open "${msg.name}"` });
        await this.broadcastProjects();
        await this.broadcastSnapshots();
        return;
      case 'saveNow': {
        if (client.role !== 'control') return;
        if (this.saveTimer) {
          await this.flushSave();
        } else {
          // Nothing pending: write anyway, so the user gets an explicit confirmation.
          await this.queueSave();
        }
        return;
      }
      case 'duplicateProject': {
        if (client.role !== 'control') return;
        if (!PROJECT_NAME_RE.test(msg.name)) {
          this.send(client, { t: 'error', message: `"${msg.name}" is not a valid project name` });
          return;
        }
        try {
          await this.flushSave();
          const copy = await this.store.duplicate(this.projectName, msg.name, this.doc.project);
          this.keepLastProject = null;
          this.setProject(msg.name, copy);
          await this.writeServerState();
          this.log.info(`saved "${msg.name}" as a copy of the open project and opened it`);
          this.broadcastFull();
          this.broadcast({ t: 'saved', project: msg.name, at: Date.now() }, 'control');
        } catch (err) {
          const message = err instanceof ProjectError ? err.message : String(err);
          this.send(client, { t: 'error', message: `Save As failed: ${message}` });
        }
        await this.broadcastProjects();
        await this.broadcastSnapshots();
        return;
      }
      case 'snapshotCreate': {
        if (client.role !== 'control') return;
        try {
          await this.flushSave();
          const info = await this.store.createSnapshot(this.projectName, msg.label, this.doc.project);
          this.log.info(`snapshot "${info.label}" saved in "${this.projectName}"`);
        } catch (err) {
          this.send(client, { t: 'error', message: `snapshot failed: ${String(err)}` });
        }
        await this.broadcastSnapshots();
        return;
      }
      case 'snapshotRestore': {
        if (client.role !== 'control') return;
        try {
          const restored = await this.store.readSnapshot(this.projectName, msg.id);
          await this.flushSave();
          // Keep the state being replaced, so a restore can itself be undone.
          await this.store.createSnapshot(this.projectName, 'before restore', this.doc.project);
          const { name: _ignored, version: _v, ...fields } = restored;
          const ops = Object.entries(fields).map(([key, value]) => ({ op: 'set' as const, path: ['project', key], value }));
          const error = this.applyPatch(ops, 'server');
          if (error) throw new ProjectError(error);
          this.log.info(`restored snapshot ${msg.id} in "${this.projectName}"`);
        } catch (err) {
          const message = err instanceof ProjectError ? err.message : String(err);
          this.send(client, { t: 'error', message: `restore failed: ${message}` });
        }
        await this.broadcastSnapshots();
        return;
      }
      case 'snapshotDelete': {
        if (client.role !== 'control') return;
        try {
          await this.store.deleteSnapshot(this.projectName, msg.id);
        } catch (err) {
          this.send(client, { t: 'error', message: `delete failed: ${String(err)}` });
        }
        await this.broadcastSnapshots();
        return;
      }
      case 'createProject': {
        if (client.role !== 'control') return;
        try {
          const project = await this.store.create(msg.name);
          this.keepLastProject = null;
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
        await this.broadcastSnapshots();
        return;
      }
      case 'openProfile': {
        if (client.role !== 'control' || msg.name === this.doc.profile.name) return;
        if (!(await this.profiles.list()).includes(msg.name)) {
          this.send(client, { t: 'error', message: `no output profile "${msg.name}"` });
          return;
        }
        await this.flushProfileSave();
        const { profile, warning } = await this.profiles.load(msg.name);
        if (warning) this.log.warn(warning);
        this.setProfile(profile);
        return;
      }
      case 'createProfile': {
        if (client.role !== 'control') return;
        if (!PROJECT_NAME_RE.test(msg.name) || (await this.profiles.list()).includes(msg.name)) {
          this.send(client, { t: 'error', message: `cannot create output profile "${msg.name}"` });
          return;
        }
        await this.flushProfileSave();
        // A new profile starts from the current calibration, renamed.
        const profile: OutputProfile = { ...this.doc.profile, name: msg.name };
        await this.profiles.save(profile);
        this.setProfile(profile);
        this.log.info(`created output profile "${msg.name}"`);
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
    this.doc = {
      project,
      session: this.doc?.session ?? this.bootSession ?? defaultSession(Date.now()),
      profile: this.doc?.profile ?? this.bootProfile ?? defaultProfile(DEFAULT_PROFILE),
    };
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
        this.broadcast({ t: 'saved', project: name, at: Date.now() }, 'control');
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

  private setProfile(profile: OutputProfile): void {
    this.doc = { ...this.doc, profile };
    this.rev++;
    this.broadcastFull();
    void this.writeServerState();
    void this.broadcastProfiles();
  }

  private scheduleProfileSave(): void {
    if (this.profileTimer) clearTimeout(this.profileTimer);
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null;
      void this.saveProfile();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveProfile(): Promise<void> {
    try {
      await this.profiles.save(this.doc.profile);
    } catch (err) {
      this.log.error(`saving output profile "${this.doc.profile.name}" failed: ${String(err)}`);
    }
  }

  private async flushProfileSave(): Promise<void> {
    if (!this.profileTimer) return;
    clearTimeout(this.profileTimer);
    this.profileTimer = null;
    await this.saveProfile();
  }

  private async snapshotsMessage(): Promise<ServerMessage> {
    return { t: 'snapshots', project: this.projectName, list: await this.store.listSnapshots(this.projectName) };
  }

  private async sendSnapshots(client: Client): Promise<void> {
    this.send(client, await this.snapshotsMessage());
  }

  private async broadcastSnapshots(): Promise<void> {
    this.broadcast(await this.snapshotsMessage(), 'control');
  }

  private async sendProfiles(client: Client): Promise<void> {
    this.send(client, { t: 'profiles', names: await this.profiles.list(), current: this.doc.profile.name });
  }

  private async broadcastProfiles(): Promise<void> {
    this.broadcast({ t: 'profiles', names: await this.profiles.list(), current: this.doc.profile.name }, 'control');
  }

  private scheduleStateWrite(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.writeServerState();
    }, SAVE_DEBOUNCE_MS);
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
      const state: ServerState = { lastProject: this.keepLastProject ?? this.projectName, lastProfile: this.doc?.profile.name, session: this.doc?.session };
      await writeFileAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
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
      profile: this.doc.profile,
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
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      await this.writeServerState();
    }
    await this.flushProfileSave();
    this.unsubscribeLog();
    await this.flushSave();
    for (const c of this.clients) c.socket.close(1001, 'server shutting down');
  }
}
