import { loadSetting, saveSetting } from './ui.ts';

/**
 * WAI-ARIA tabs over existing markup: `[role=tab]` buttons inside `tablist`, each with
 * `aria-controls` naming its `[role=tabpanel]`. One panel is visible at a time; the choice
 * is remembered. Arrow keys, Home and End move between tabs (automatic activation).
 */
export class Tabs {
  private tabs: HTMLButtonElement[];
  private current = '';

  constructor(
    tablist: HTMLElement,
    private storeKey: string,
    private onShow: (panelId: string) => void = () => {},
  ) {
    this.tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.show(this.panelOf(tab)));
      tab.addEventListener('keydown', (ev) => this.onKey(ev, tab));
    }
    const stored = loadSetting(storeKey);
    const first = this.tabs[0];
    const initial = this.tabs.find((t) => this.panelOf(t) === stored) ?? first;
    if (initial) this.show(this.panelOf(initial), false);
  }

  get active(): string {
    return this.current;
  }

  show(panelId: string, remember = true): void {
    this.current = panelId;
    for (const tab of this.tabs) {
      const id = this.panelOf(tab);
      const on = id === panelId;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(id);
      if (panel) panel.hidden = !on;
    }
    if (remember) saveSetting(this.storeKey, panelId);
    this.onShow(panelId);
  }

  private panelOf(tab: HTMLElement): string {
    return tab.getAttribute('aria-controls') ?? '';
  }

  private onKey(ev: KeyboardEvent, tab: HTMLButtonElement): void {
    const i = this.tabs.indexOf(tab);
    const n = this.tabs.length;
    let j: number;
    if (ev.key === 'ArrowRight') j = (i + 1) % n;
    else if (ev.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = n - 1;
    else return;
    ev.preventDefault();
    const next = this.tabs[j];
    if (!next) return;
    this.show(this.panelOf(next));
    next.focus();
  }
}
