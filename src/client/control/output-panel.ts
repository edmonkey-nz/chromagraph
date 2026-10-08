import type { BladeApi, FolderApi } from 'tweakpane';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Output" card: the background colour. Glow and trails are per layer (each layer card),
 * and the diagnostic switches are in the Diagnostics tab.
 */

export interface OutputPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
}

type Binding = BladeApi & { refresh(): void };

export class OutputPanel {
  private model = { background: '#000000' };
  private binding: Binding;
  private quietDepth = 0;

  constructor(
    root: FolderApi,
    private deps: OutputPanelDeps,
  ) {
    this.binding = root.addBinding(this.model, 'background').on('change', (ev) => {
      if (this.quietDepth === 0) this.deps.sendPatch([{ op: 'set', path: ['project', 'output', 'background'], value: ev.value }]);
    }) as Binding;
  }

  /** Reconcile with a new document; our own echoes are ignored (the picker already shows them). */
  update(doc: SyncDoc, external: boolean): void {
    if (!external || this.model.background === doc.project.output.background) return;
    this.model.background = doc.project.output.background;
    this.quietDepth++;
    try {
      this.binding.refresh();
    } finally {
      this.quietDepth--;
    }
  }
}
