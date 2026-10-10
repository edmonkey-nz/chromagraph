import type { Table } from '../../data/columns.ts';
import { cellFormatter, columnChars, sortRows, type SortDir } from '../../data/table-view.ts';
import { h } from './ui.ts';

/**
 * A dataset's rows as parsed, in the Datasets tab ("View rows" on a dataset card). Only the
 * rows in view are in the DOM (a small pool of row elements is reused as it scrolls), so a
 * 100k-row file scrolls as freely as a small one. Row numbers count data rows from 1, as the
 * parse report's messages do. A header click sorts by that column (ascending, descending,
 * then file order); missing values show as a dim dash and always sort last. Cell text comes
 * from data/table-view.ts.
 */

const ROW_H = 22;
/** Rows drawn above and below the visible ones. */
const OVERSCAN = 8;
const MISSING = '—';

interface RowEl {
  el: HTMLElement;
  num: HTMLElement;
  cells: HTMLElement[];
}

export class TableViewer {
  readonly el = h('div', { className: 'tv' });
  private info = h('span', { className: 'muted small' });
  private jump = h('input', { type: 'number', min: '1', step: '1', placeholder: 'row', className: 'tv-jump' });
  private scroller = h('div', { className: 'tv-scroll' });
  private inner = h('div', { className: 'tv-inner' });
  private head = h('div', { className: 'tv-row tv-head' });
  private rowsEl = h('div', { className: 'tv-rows' });
  private pool: RowEl[] = [];
  private table: Table | null = null;
  private timeZone = '';
  private formats: ((row: number) => string | null)[] = [];
  private sort: { column: number; dir: SortDir; order: Uint32Array } | null = null;
  /** The row (file order) to highlight after a jump, until the next jump or sort. */
  private hit = -1;
  private frame = 0;

  constructor() {
    this.jump.setAttribute('aria-label', 'Go to row');
    this.jump.title = 'Go to a row (counting data rows from 1, as the parse messages do). Enter jumps';
    this.jump.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const n = Number(this.jump.value);
      if (Number.isInteger(n)) this.goTo(n - 1);
    });
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'table');
    this.scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.inner.append(this.head, this.rowsEl);
    this.scroller.append(this.inner);
    this.el.append(h('div', { className: 'tv-bar' }, this.info, h('label', { className: 'tv-jump-label' }, 'go to row', this.jump)), this.scroller);
  }

  /** Show `table` with times in `timeZone`. Cheap when neither changed. */
  setTable(table: Table, timeZone: string): void {
    if (table === this.table && timeZone === this.timeZone) return;
    const fresh = table !== this.table;
    this.table = table;
    this.timeZone = timeZone;
    this.formats = table.columns.map((c) => cellFormatter(c, timeZone));
    if (fresh) {
      this.sort = null;
      this.hit = -1;
      this.scroller.scrollTop = 0;
      this.buildHead();
    }
    for (const p of this.pool) p.num.dataset.row = '';
    this.renderInfo();
    this.schedule();
  }

  /** Scroll to data row `row` (0-based, file order) and highlight it. */
  goTo(row: number): void {
    const t = this.table;
    if (!t || t.rowCount === 0) return;
    const r = Math.min(Math.max(Math.round(row), 0), t.rowCount - 1);
    this.hit = r;
    const at = this.sort ? this.sort.order.indexOf(r) : r;
    const view = this.scroller.clientHeight - ROW_H;
    this.scroller.scrollTop = Math.max(0, at * ROW_H - view / 2 + ROW_H / 2);
    this.jump.value = String(r + 1);
    this.schedule();
  }

  private buildHead(): void {
    const t = this.table!;
    const widths = t.columns.map((c, i) => `calc(${columnChars(c, t.rowCount, this.formats[i]!)}ch + 16px)`);
    const digits = String(t.rowCount).length;
    this.inner.style.setProperty('--tv-cols', `calc(${Math.max(digits, 3) + 1}ch + 16px) ${widths.join(' ')}`);
    this.inner.style.height = `${(t.rowCount + 1) * ROW_H}px`;
    const num = h('div', { className: 'tv-cell tv-num', textContent: '#', title: 'Row in the file (data rows from 1). Click for file order' });
    num.setAttribute('role', 'columnheader');
    num.addEventListener('click', () => this.setSort(null));
    this.head.replaceChildren(
      num,
      ...t.columns.map((c, i) => {
        const cell = h('button', { type: 'button', className: `tv-cell tv-sort${c.type === 'number' || c.type === 'time' ? ' tv-right' : ''}`, textContent: c.name });
        cell.title = `${c.name} (${c.empty ? 'empty' : c.type}). Click to sort`;
        cell.setAttribute('role', 'columnheader');
        cell.addEventListener('click', () => this.setSort(i));
        return cell;
      }),
    );
    for (const p of this.pool) p.el.remove();
    this.pool = [];
  }

  /** Sort by column `i` (ascending, then descending, then file order), or file order with null. */
  private setSort(i: number | null): void {
    const t = this.table;
    if (!t) return;
    const was = this.sort;
    if (i === null || (was?.column === i && was.dir === 'desc')) this.sort = null;
    else {
      const dir: SortDir = was?.column === i ? 'desc' : 'asc';
      this.sort = { column: i, dir, order: sortRows(t.columns[i]!, t.rowCount, dir) };
    }
    const cells = this.head.children;
    for (let k = 1; k < cells.length; k++) {
      const cell = cells[k] as HTMLElement;
      const on = this.sort?.column === k - 1;
      cell.dataset.sort = on ? this.sort!.dir : '';
      cell.setAttribute('aria-sort', on ? (this.sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    this.renderInfo();
    if (this.hit >= 0) this.goTo(this.hit);
    else this.schedule();
  }

  private renderInfo(): void {
    const t = this.table;
    if (!t) return;
    const s = this.sort;
    const by = s ? ` · sorted by ${t.columns[s.column]!.name} ${s.dir === 'asc' ? '↑' : '↓'}` : '';
    this.info.textContent = `${t.rowCount.toLocaleString('en-NZ')} rows${by}`;
    this.jump.max = String(t.rowCount);
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Fill the pool rows with the rows now in view. */
  private render(): void {
    const t = this.table;
    if (!t || !this.el.isConnected || this.scroller.clientHeight === 0) return;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.min(t.rowCount - first, Math.ceil(this.scroller.clientHeight / ROW_H) + OVERSCAN * 2);
    while (this.pool.length < count) this.pool.push(this.makeRow(t.columns.length));
    this.rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    const order = this.sort?.order;
    for (let k = 0; k < this.pool.length; k++) {
      const p = this.pool[k]!;
      if (k >= count) {
        p.el.hidden = true;
        continue;
      }
      p.el.hidden = false;
      const row = order ? order[first + k]! : first + k;
      p.el.classList.toggle('tv-hit', row === this.hit);
      const key = String(row);
      if (p.num.dataset.row === key) continue;
      p.num.dataset.row = key;
      p.num.textContent = String(row + 1);
      for (let c = 0; c < p.cells.length; c++) {
        const text = this.formats[c]!(row);
        const cell = p.cells[c]!;
        cell.textContent = text ?? MISSING;
        cell.classList.toggle('tv-missing', text === null);
      }
    }
  }

  private makeRow(columns: number): RowEl {
    const t = this.table!;
    const num = h('div', { className: 'tv-cell tv-num' });
    const cells = t.columns.slice(0, columns).map((c) => h('div', { className: `tv-cell${c.type === 'number' || c.type === 'time' ? ' tv-right' : ''}` }));
    const el = h('div', { className: 'tv-row' }, num, ...cells);
    el.setAttribute('role', 'row');
    this.rowsEl.append(el);
    return { el, num, cells };
  }
}
