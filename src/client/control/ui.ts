/**
 * Small DOM helpers for the control window: element builder, icons, titled cards with a
 * collapsible body, remembered UI settings (localStorage, best effort) and a name dialog.
 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(el, rest);
  if (dataset) for (const [k, v] of Object.entries(dataset)) el.dataset[k] = v;
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

// ---- icons ---------------------------------------------------------------------------------
// 16 px stroke icons (static markup, never built from data).

const ICON_PATHS = {
  chevron: '<path d="M6 4l4 4-4 4"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  restart: '<path d="M4 3.5v9M12.5 3.5L6 8l6.5 4.5z"/>',
  key: '<path d="M6.5 2.5l4 4-4 4-4-4z"/><path d="M12.5 9.5v4M10.5 11.5h4"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  prev: '<path d="M10 4l-4 4 4 4"/>',
  next: '<path d="M6 4l4 4-4 4"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3"/>',
  pencil: '<path d="M3 13l.6-2.6L10.8 3.2l2 2-7.2 7.2z"/>',
  save: '<path d="M3.5 2.5h7l2 2v9h-9z"/><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  camera: '<rect x="2.5" y="4.5" width="11" height="8" rx="1.5"/><circle cx="8" cy="8.5" r="2"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
  projector: '<rect x="1.5" y="5.5" width="13" height="6" rx="1.5"/><circle cx="10.5" cy="8.5" r="1.6"/><path d="M4 11.5v1.5M12 11.5v1.5M4 8h2.5"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.7-.8 1.3v.3"/><circle cx="8" cy="11.6" r=".5" fill="currentColor"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** A small square button with an icon and an accessible label (also its tooltip). */
export function iconButton(name: IconName, label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = h('button', { type: 'button', className: `icon-btn ${className}`.trim(), title: label }, icon(name));
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

// ---- remembered settings ---------------------------------------------------------------------

const PREFIX = 'data-wrangler.control.';

export function loadSetting(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage unavailable (private window, blocked site data): the setting just isn't kept.
  }
}

// ---- cards -------------------------------------------------------------------------------------

export interface CardOptions {
  title: string;
  /** Short note after the title (e.g. a count). */
  note?: string;
  /** Remember the collapsed state under this key. */
  storeKey?: string;
  collapsed?: boolean;
  className?: string;
  onToggle?(collapsed: boolean): void;
}

let cardSeq = 0;

/**
 * A titled group of controls. The header is a button that collapses the body (keyboard:
 * Enter/Space); `actions` sits at the right of the header for card-level buttons.
 */
export class Card {
  readonly root: HTMLElement;
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly actions: HTMLElement;
  private toggle: HTMLButtonElement;
  private titleEl: HTMLElement;
  private noteEl: HTMLElement;
  private badgeEl: HTMLElement;
  private collapsedState: boolean;

  constructor(private opts: CardOptions) {
    const bodyId = `card-body-${++cardSeq}`;
    this.titleEl = h('span', { className: 'card-title', textContent: opts.title });
    this.noteEl = h('span', { className: 'card-note', textContent: opts.note ?? '' });
    this.badgeEl = h('span', { className: 'card-badge' });
    this.toggle = h('button', { type: 'button', className: 'card-toggle' }, icon('chevron'), this.badgeEl, this.titleEl, this.noteEl);
    this.toggle.setAttribute('aria-controls', bodyId);
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.collapsedState, true));
    this.actions = h('div', { className: 'card-actions' });
    this.head = h('header', { className: 'card-head' }, this.toggle, this.actions);
    this.body = h('div', { className: 'card-body', id: bodyId });
    this.root = h('section', { className: `card ${opts.className ?? ''}`.trim() }, this.head, this.body);
    this.root.setAttribute('aria-label', opts.title);
    const stored = opts.storeKey ? loadSetting(`card.${opts.storeKey}`) : null;
    this.collapsedState = stored === null ? (opts.collapsed ?? false) : stored === 'collapsed';
    this.setCollapsed(this.collapsedState, false);
  }

  get collapsed(): boolean {
    return this.collapsedState;
  }

  setCollapsed(collapsed: boolean, user = false): void {
    this.collapsedState = collapsed;
    this.root.classList.toggle('collapsed', collapsed);
    this.body.hidden = collapsed;
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
    if (user) {
      if (this.opts.storeKey) saveSetting(`card.${this.opts.storeKey}`, collapsed ? 'collapsed' : 'open');
      this.opts.onToggle?.(collapsed);
    }
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title;
    this.root.setAttribute('aria-label', title);
  }

  setNote(note: string): void {
    this.noteEl.textContent = note;
  }

  /** Short tag before the title (a layer's stack position); empty hides it. */
  setBadge(text: string): void {
    this.badgeEl.textContent = text;
  }

  focusHeader(): void {
    this.toggle.focus();
  }
}

// ---- name dialog ---------------------------------------------------------------------------

export interface AskOptions {
  title: string;
  label: string;
  initial?: string;
  okText?: string;
  /** Error message for an unusable value, or null when it is fine. */
  validate?(value: string): string | null;
}

/**
 * Ask for a name in a modal dialog. Resolves with the trimmed value, or null when cancelled.
 * Invalid values are explained inline and the dialog stays open.
 */
export function askName(opts: AskOptions): Promise<string | null> {
  const input = h('input', { type: 'text', value: opts.initial ?? '', spellcheck: false, autocomplete: 'off' });
  const error = h('p', { className: 'dialog-error' });
  error.setAttribute('role', 'alert');
  const cancel = h('button', { type: 'button', className: 'btn ghost', textContent: 'Cancel' });
  const ok = h('button', { type: 'submit', className: 'btn primary', textContent: opts.okText ?? 'OK' });
  const form = h(
    'form',
    { method: 'dialog' },
    h('h2', { textContent: opts.title }),
    h('label', { className: 'dialog-field' }, h('span', { textContent: opts.label }), input),
    error,
    h('div', { className: 'dialog-actions' }, cancel, ok),
  );
  const dialog = h('dialog', { className: 'dialog' }, form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let result: string | null = null;
    const check = (): string | null => opts.validate?.(input.value.trim()) ?? null;
    input.addEventListener('input', () => {
      if (error.textContent) error.textContent = check() ?? '';
    });
    form.addEventListener('submit', (ev) => {
      const message = check();
      if (message !== null) {
        ev.preventDefault();
        error.textContent = message;
        input.focus();
        return;
      }
      result = input.value.trim();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    input.select();
  });
}
