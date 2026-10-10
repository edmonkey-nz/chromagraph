import { h, icon } from './ui.ts';

/**
 * A dropdown whose options each show a short description under the name, which a native
 * <select> can't do. A button that looks like the other selects opens a popover listbox
 * (light dismiss: Escape or clicking outside closes it). Keys: Up/Down/Home/End move,
 * Enter or Space chooses, a letter jumps to the next option starting with it.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** One sentence at most. */
  description: string;
}

/** Below the button when at least this much room is left there (px), else whichever side has more. */
const MIN_ROOM_BELOW = 260;

export class ChoiceMenu<T extends string> {
  readonly el = h('div', { className: 'choice-menu' });
  private button = h('button', { type: 'button', className: 'choice-button' });
  private buttonLabel = h('span', { className: 'choice-button-label' });
  private pop = h('div', { className: 'choice-pop' });
  private options: HTMLElement[] = [];
  private current: T;

  constructor(
    private choices: readonly Choice<T>[],
    initial: T,
    label: string,
    private onChange: (value: T) => void,
  ) {
    this.current = initial;
    const id = `choice-${Math.random().toString(36).slice(2, 10)}`;
    this.pop.id = id;
    this.pop.popover = 'auto';
    this.pop.setAttribute('role', 'listbox');
    this.pop.setAttribute('aria-label', label);
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-controls', id);
    this.button.setAttribute('aria-expanded', 'false');
    this.button.popoverTargetElement = this.pop;
    this.button.append(this.buttonLabel, icon('chevron'));
    this.button.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      this.pop.showPopover();
    });

    this.options = choices.map((c, i) => {
      const opt = h('div', { className: 'choice-option', tabIndex: -1 }, h('span', { className: 'choice-name', textContent: c.label }), h('span', { className: 'choice-desc', textContent: c.description }));
      opt.setAttribute('role', 'option');
      opt.addEventListener('click', () => this.choose(i));
      opt.addEventListener('pointermove', () => {
        if (document.activeElement !== opt) opt.focus({ preventScroll: true });
      });
      return opt;
    });
    this.pop.append(...this.options);
    this.pop.addEventListener('keydown', (ev) => this.key(ev));
    this.pop.addEventListener('beforetoggle', (ev) => {
      if ((ev as ToggleEvent).newState === 'open') this.place();
    });
    this.pop.addEventListener('toggle', (ev) => {
      const open = (ev as ToggleEvent).newState === 'open';
      this.button.setAttribute('aria-expanded', String(open));
      if (!open) return;
      const i = Math.max(0, this.choices.findIndex((c) => c.value === this.current));
      this.options[i]?.focus({ preventScroll: true });
      this.options[i]?.scrollIntoView({ block: 'nearest' });
    });
    // The popover is fixed under the button, so a scroll or resize elsewhere would leave it behind.
    const closeOnMove = (ev: Event) => {
      if (this.pop.matches(':popover-open') && !(ev.target instanceof Node && this.pop.contains(ev.target))) this.pop.hidePopover();
    };
    window.addEventListener('scroll', closeOnMove, true);
    window.addEventListener('resize', closeOnMove);

    this.el.append(this.button, this.pop);
    this.render();
  }

  get value(): T {
    return this.current;
  }

  /** Closes the list and puts focus back on the button (hidePopover leaves it on the page). */
  private close(): void {
    this.pop.hidePopover();
    this.button.focus();
  }

  private choose(i: number): void {
    const c = this.choices[i];
    if (!c) return;
    this.close();
    if (c.value === this.current) return;
    this.current = c.value;
    this.render();
    this.onChange(c.value);
  }

  private render(): void {
    const chosen = this.choices.find((c) => c.value === this.current);
    this.buttonLabel.textContent = chosen?.label ?? '';
    this.button.title = chosen?.description ?? '';
    this.options.forEach((opt, i) => opt.setAttribute('aria-selected', String(this.choices[i]?.value === this.current)));
  }

  private key(ev: KeyboardEvent): void {
    const at = this.options.indexOf(document.activeElement as HTMLElement);
    const n = this.options.length;
    let next: number | null = null;
    if (ev.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(n - 1, at + 1);
    else if (ev.key === 'ArrowUp') next = at < 0 ? n - 1 : Math.max(0, at - 1);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (at >= 0) this.choose(at);
      return;
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
      return;
    } else if (ev.key === 'Tab') {
      this.pop.hidePopover();
      return;
    } else if (ev.key.length === 1 && /\S/.test(ev.key)) {
      const k = ev.key.toLowerCase();
      for (let s = 1; s <= n; s++) {
        const j = (Math.max(at, 0) + s) % n;
        if (this.choices[j]?.label.toLowerCase().startsWith(k)) {
          next = j;
          break;
        }
      }
    }
    if (next === null) return;
    ev.preventDefault();
    this.options[next]?.focus();
  }

  /** Under the button (or above it when there is more room there), at least as wide as it. */
  private place(): void {
    const r = this.button.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const s = this.pop.style;
    s.width = `${Math.round(width)}px`;
    s.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8)))}px`;
    if (below >= MIN_ROOM_BELOW || below >= above) {
      s.top = `${Math.round(r.bottom + 4)}px`;
      s.bottom = 'auto';
      s.maxHeight = `${Math.round(below)}px`;
    } else {
      s.top = 'auto';
      s.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
      s.maxHeight = `${Math.round(above)}px`;
    }
  }
}
