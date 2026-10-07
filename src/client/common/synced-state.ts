import { applyOps, type PatchOp } from '../../shared/patch.ts';
import { ProjectSchema, SessionSchema, type SyncDoc } from '../../shared/project-schema.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

export interface ChangeInfo {
  full: boolean;
  ops?: PatchOp[];
  origin?: string;
}

/**
 * Client-side mirror of the server's SyncDoc. Applies full snapshots and in-order
 * patches; on a rev gap or a patch that fails to apply it asks for a fresh snapshot and
 * keeps the last good state meanwhile.
 */
export class SyncedState {
  rev = -1;
  projectName = '';
  doc: SyncDoc | null = null;

  constructor(
    private onChange: (doc: SyncDoc, prev: SyncDoc | null, info: ChangeInfo) => void,
    private requestFull: () => void,
    private warn: (message: string) => void = console.warn,
  ) {}

  /** Seed from a locally cached snapshot (validated); returns false if unusable. */
  seed(projectName: string, rev: number, doc: unknown): boolean {
    const d = doc as Partial<SyncDoc> | null;
    const p = ProjectSchema.safeParse(d?.project);
    if (!p.success) return false;
    const s = SessionSchema.safeParse(d?.session);
    this.projectName = projectName;
    this.rev = rev;
    this.set({ project: p.data, session: s.success ? s.data : { testPattern: false, debugOverlay: false } }, { full: true });
    return true;
  }

  /** Returns true when the message was a state message. */
  handle(msg: ServerMessage): boolean {
    if (msg.t === 'full') {
      const p = ProjectSchema.safeParse(msg.project);
      const s = SessionSchema.safeParse(msg.session);
      if (!p.success || !s.success) {
        this.warn('server sent an invalid snapshot; keeping the last good state');
        return true;
      }
      this.projectName = msg.projectName;
      this.rev = msg.rev;
      this.set({ project: p.data, session: s.data }, { full: true });
      return true;
    }
    if (msg.t === 'patch') {
      if (!this.doc || msg.rev !== this.rev + 1) {
        this.requestFull();
        return true;
      }
      let next: SyncDoc;
      try {
        next = applyOps(this.doc, msg.ops);
      } catch (err) {
        this.warn(`patch rev ${msg.rev} failed to apply (${String(err)}); resyncing`);
        this.requestFull();
        return true;
      }
      this.rev = msg.rev;
      this.set(next, { full: false, ops: msg.ops, origin: msg.origin });
      return true;
    }
    return false;
  }

  private set(doc: SyncDoc, info: ChangeInfo): void {
    const prev = this.doc;
    this.doc = doc;
    this.onChange(doc, prev, info);
  }
}
