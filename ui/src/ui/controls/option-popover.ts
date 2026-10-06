import { MENU_HEADER_CLASS } from '../menu-styles';
import { ChoiceImage, type ChoiceItem } from './choice-item';

export type OptionPopoverMode = 'list' | 'grid';

export interface OptionPopoverOptions<V> {
  /** What the popover hangs off, and where focus returns after a choice or Escape. */
  anchor: HTMLElement;
  items: readonly ChoiceItem<V>[];
  /** The chosen item's value — marked selected and focused on open. */
  value?: V;
  /** `'list'` (default): a row per item. `'grid'`: labelled images, `columns` wide. */
  mode?: OptionPopoverMode;
  /** Grid only, 2–6; 3 without one. */
  columns?: number;
  /** A search box over label, description and keywords. */
  search?: boolean;
  /** A choice was made; the popover has already closed and focus is back on the anchor. */
  onChoose(value: V): void;
  /** The popover closed, by a choice or without one. */
  onClose?(): void;
}

/** A popover several options may be chosen from: a choice toggles its option and the popover stays open. */
export interface OptionMultiPopoverOptions<V> extends Omit<OptionPopoverOptions<V>, 'value' | 'onChoose'> {
  multiple: true;
  /** The chosen items' values — each marked selected and checked; the first is focused on open. */
  values: readonly V[];
  /** An option was chosen or let go; the popover is still open, and already shows it so. */
  onToggle(value: V): void;
}

// The menu look (menu-styles.ts) from the page body: a dialog's body is a
// clipping scroller, and a grid may be wider than the dialog it serves.
// z-[1200] clears the feature dialogs, as the Custom menu's dropdown does.
// Opaque (bg-base-200), where a menu is panel-bg: it opens over the dialog's
// own rows, and their text would read through a see-through panel.
const PANEL =
  'fixed z-[1200] flex flex-col p-1 max-w-[calc(100vw-16px)] text-xs '
  + 'bg-base-200 border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
const SEARCH = 'input input-sm input-bordered w-full text-xs mb-1 shrink-0';
const LIST = 'flex-1 min-h-0 overflow-y-auto focus:outline-none';
const ROWS = 'flex flex-col';
const CELLS = 'grid gap-1';
const SELECTED = 'bg-primary/15';
// MENU_ROW_CLASS at the dialogs' text size (its own 13px would fight a second size class).
const ROW =
  'flex items-center gap-2 w-full min-w-0 px-2 py-1.5 rounded text-left text-xs '
  + 'text-base-content/80 cursor-pointer hover:bg-base-content/[0.08] '
  + 'focus-visible:outline-none focus-visible:bg-base-content/[0.08]';
const CELL =
  'flex flex-col items-center gap-1 min-w-0 p-1.5 rounded cursor-pointer text-base-content/80 '
  + 'hover:bg-base-content/[0.08] focus-visible:outline-none focus-visible:bg-base-content/[0.08]';
const CELL_LABEL = 'block max-w-full truncate text-[11px] leading-tight';
const DESCRIPTION = 'block truncate text-[11px] text-base-content/50';
const EMPTY = 'px-2 py-1.5 text-base-content/50 select-none';
// Several may be chosen: every option carries a check mark, drawn only while it is — a
// row's ahead of its label, where it keeps the labels in one column; a cell's in its corner.
const CHECK = 'shrink-0 w-3.5 h-3.5 text-primary';
const CELL_CHECK = `absolute top-1 right-1 ${CHECK}`;
const UNCHECKED = 'invisible';
const CHECK_PATH = 'M3 8.5l3.2 3.2L13 4.8';

/** Clearance from the window's edges, in pixels. */
const EDGE = 8;
/** Gap between the anchor and the popover, in pixels. */
const GAP = 4;
/** The tallest the popover grows before its list scrolls, in pixels. */
const MAX_HEIGHT = 320;
/** The least it is squeezed to in a short window, in pixels. */
const MIN_HEIGHT = 96;
/** A grid cell's width while the window has room for it, in rem. */
const CELL_REM = 5.5;

/**
 * A listbox of choices that hangs off an anchor: rows or a grid of labelled
 * images, under group headings, with an optional search box. It lives on the
 * page body, flips above the anchor when the window leaves no room below,
 * and closes on a choice, a press or wheel elsewhere, Tab and Escape — an
 * Escape it keeps to itself, so a dialog under it stays open. With
 * `multiple`, a choice toggles its option's check mark and the popover
 * stays open until it is dismissed.
 */
export class OptionPopover<V> {
  /** The floating panel; on the page body only while open. */
  readonly element: HTMLElement;

  private readonly anchor: HTMLElement;
  private readonly items: readonly ChoiceItem<V>[];
  private readonly value: V | undefined;
  /** Several may be chosen: the values that are, as toggled since. Null where one is. */
  private readonly selected: Set<V> | null;
  private readonly mode: OptionPopoverMode;
  private readonly columns: number;
  private readonly onChoose?: (value: V) => void;
  private readonly onToggle?: (value: V) => void;
  private readonly onClose?: () => void;

  private readonly searchInput: HTMLInputElement | null = null;
  private readonly list: HTMLElement;
  /** The options on show, in reading order, and the items behind them. */
  private options: HTMLElement[] = [];
  private shown: ChoiceItem<V>[] = [];
  /** The options as rows (a list's rows hold one each) — what the arrows walk. */
  private rows: number[][] = [];
  /** The one option in the tab order. */
  private active = -1;
  private opened = false;

  constructor(options: OptionPopoverOptions<V> | OptionMultiPopoverOptions<V>) {
    this.anchor = options.anchor;
    this.items = options.items;
    if ('multiple' in options) {
      this.value = undefined;
      this.selected = new Set(options.values);
      this.onToggle = options.onToggle;
    } else {
      this.value = options.value;
      this.selected = null;
      this.onChoose = options.onChoose;
    }
    this.mode = options.mode ?? 'list';
    this.columns = Math.min(6, Math.max(2, Math.round(options.columns ?? 3)));
    this.onClose = options.onClose;

    this.element = document.createElement('div');
    this.element.className = PANEL;
    this.element.dataset.mode = this.mode;
    if (this.mode === 'grid') {
      this.element.dataset.columns = String(this.columns);
    }
    if (options.search) {
      this.searchInput = document.createElement('input');
      this.searchInput.type = 'search';
      this.searchInput.className = SEARCH;
      this.searchInput.placeholder = 'Search';
      this.searchInput.autocomplete = 'off';
      this.searchInput.spellcheck = false;
      this.searchInput.setAttribute('aria-label', 'Search');
      this.searchInput.addEventListener('input', () => this.render());
      this.element.appendChild(this.searchInput);
    }
    this.list = document.createElement('div');
    this.list.className = LIST;
    this.list.setAttribute('role', 'listbox');
    if (this.selected) {
      this.list.setAttribute('aria-multiselectable', 'true');
    }
    this.list.tabIndex = -1;
    this.list.addEventListener('click', this.onClick);
    this.element.appendChild(this.list);
    this.element.addEventListener('keydown', this.onPanelKeyDown);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    if (this.searchInput) {
      this.searchInput.value = '';
    }
    this.render();
    document.body.appendChild(this.element);
    this.position();
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    document.addEventListener('wheel', this.onMovedUnder, { capture: true, passive: true });
    document.addEventListener('scroll', this.onMovedUnder, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);
    // The chosen option (the first of several) when there is one; else the search box, so typing filters at once.
    const chosen = this.shown.findIndex(item => this.isChosen(item));
    if (chosen < 0 && this.searchInput) {
      this.searchInput.focus({ preventScroll: true });
    } else if (this.options.length) {
      this.focusOption(Math.max(chosen, 0));
    } else {
      // Nothing to choose: focus still leaves the anchor, so its keys can't reopen what is open.
      this.list.focus({ preventScroll: true });
    }
  }

  /** Off the page, listeners with it. Focus stays where it is. */
  close(): void {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    this.element.remove();
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    document.removeEventListener('wheel', this.onMovedUnder, { capture: true });
    document.removeEventListener('scroll', this.onMovedUnder, { capture: true });
    window.removeEventListener('resize', this.onResize);
    this.onClose?.();
  }

  destroy(): void {
    this.close();
  }

  /** Case-insensitive substring over label, description and keywords. */
  static matches<V>(item: ChoiceItem<V>, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    const texts = [item.label, item.description ?? '', ...(item.keywords ?? [])];
    return texts.some(text => text.toLowerCase().includes(needle));
  }

  /** Ungrouped items first, under no heading; then each group, in first-appearance order. */
  private static sections<V>(items: readonly ChoiceItem<V>[]): { group?: string; items: ChoiceItem<V>[] }[] {
    const loose: ChoiceItem<V>[] = [];
    const groups = new Map<string, ChoiceItem<V>[]>();
    for (const item of items) {
      if (!item.group) {
        loose.push(item);
        continue;
      }
      const members = groups.get(item.group);
      if (members) {
        members.push(item);
      } else {
        groups.set(item.group, [item]);
      }
    }
    const sections: { group?: string; items: ChoiceItem<V>[] }[] = loose.length ? [{ items: loose }] : [];
    for (const [group, members] of groups) {
      sections.push({ group, items: members });
    }
    return sections;
  }

  /** Rebuild the list for what the search box says. */
  private render(): void {
    const query = this.searchInput?.value ?? '';
    const matching = this.items.filter(item => OptionPopover.matches(item, query));
    // A list keeps its labels in one column: every row gets a box once any item has an image.
    const boxed = this.mode === 'grid' || this.items.some(item => item.image);
    const perRow = this.mode === 'grid' ? this.columns : 1;
    this.options = [];
    this.shown = [];
    this.rows = [];
    this.list.replaceChildren();
    for (const section of OptionPopover.sections(matching)) {
      const body = document.createElement('div');
      body.className = this.mode === 'grid' ? CELLS : ROWS;
      if (this.mode === 'grid') {
        body.style.gridTemplateColumns = `repeat(${this.columns}, minmax(0, 1fr))`;
        body.style.width = `${this.columns * CELL_REM}rem`;
        body.style.maxWidth = '100%';
        body.style.minWidth = '100%';
      }
      if (section.group) {
        const heading = document.createElement('div');
        heading.className = MENU_HEADER_CLASS;
        heading.setAttribute('role', 'presentation');
        heading.textContent = section.group;
        this.list.appendChild(heading);
        body.setAttribute('role', 'group');
        body.setAttribute('aria-label', section.group);
      } else {
        body.setAttribute('role', 'presentation');
      }
      section.items.forEach((item, at) => {
        const index = this.options.length;
        if (at % perRow === 0) {
          this.rows.push([]);
        }
        this.rows[this.rows.length - 1].push(index);
        const option = this.mode === 'grid' ? this.buildCell(item) : this.buildRow(item, boxed);
        option.dataset.index = String(index);
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        if (this.selected) {
          option.prepend(this.buildCheck());
        }
        this.mark(option, this.isChosen(item));
        this.options.push(option);
        this.shown.push(item);
        body.appendChild(option);
      });
      this.list.appendChild(body);
    }
    if (!this.options.length) {
      const empty = document.createElement('div');
      empty.className = EMPTY;
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No matches';
      this.list.appendChild(empty);
    }
    // Of several, a search starts from its first match — Enter in the box
    // toggles what was searched for, not a chosen option further down.
    const chosen = this.selected && query.trim() ? -1 : this.shown.findIndex(item => this.isChosen(item));
    this.setActive(this.options.length ? Math.max(chosen, 0) : -1);
  }

  private buildRow(item: ChoiceItem<V>, boxed: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = ROW;
    if (boxed) {
      row.appendChild(ChoiceImage.create(item.image, ChoiceImage.THUMB));
    }
    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0';
    const label = document.createElement('span');
    label.className = 'block truncate';
    label.textContent = item.label;
    text.appendChild(label);
    if (item.description) {
      const description = document.createElement('span');
      description.className = DESCRIPTION;
      description.textContent = item.description;
      text.appendChild(description);
    }
    row.appendChild(text);
    return row;
  }

  private buildCell(item: ChoiceItem<V>): HTMLElement {
    const cell = document.createElement('div');
    // A corner check mark is placed against its own cell.
    cell.className = this.selected ? `${CELL} relative` : CELL;
    cell.title = item.description ? `${item.label} — ${item.description}` : item.label;
    cell.appendChild(ChoiceImage.create(item.image, ChoiceImage.SQUARE));
    const label = document.createElement('span');
    label.className = CELL_LABEL;
    label.textContent = item.label;
    cell.appendChild(label);
    return cell;
  }

  /** The mark an option of several carries; `mark` shows it while the option is chosen. */
  private buildCheck(): SVGElement {
    const SVG = 'http://www.w3.org/2000/svg';
    const check = document.createElementNS(SVG, 'svg');
    check.setAttribute('viewBox', '0 0 16 16');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2');
    check.setAttribute('stroke-linecap', 'round');
    check.setAttribute('stroke-linejoin', 'round');
    check.setAttribute('aria-hidden', 'true');
    check.setAttribute('class', this.mode === 'grid' ? CELL_CHECK : CHECK);
    check.dataset.role = 'check';
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', CHECK_PATH);
    check.appendChild(path);
    return check;
  }

  private isChosen(item: ChoiceItem<V>): boolean {
    return this.selected ? this.selected.has(item.value) : item.value === this.value;
  }

  /** Show an option chosen or not: its `aria-selected`, its tint and, of several, its check mark. */
  private mark(option: HTMLElement, chosen: boolean): void {
    option.setAttribute('aria-selected', String(chosen));
    option.classList.toggle(SELECTED, chosen);
    option.querySelector('[data-role="check"]')?.classList.toggle(UNCHECKED, !chosen);
  }

  /** Move the list's one tab stop. */
  private setActive(index: number): void {
    if (this.active >= 0 && this.active < this.options.length) {
      this.options[this.active].tabIndex = -1;
    }
    this.active = index;
    if (index >= 0) {
      this.options[index].tabIndex = 0;
    }
  }

  private focusOption(index: number): void {
    if (index < 0 || index >= this.options.length) {
      return;
    }
    this.setActive(index);
    this.options[index].focus({ preventScroll: true });
    this.options[index].scrollIntoView?.({ block: 'nearest' });
  }

  private choose(index: number): void {
    const item = this.shown[index];
    if (!item) {
      return;
    }
    if (this.selected) {
      this.toggle(index, item);
      return;
    }
    this.close();
    this.anchor.focus({ preventScroll: true });
    this.onChoose?.(item.value);
  }

  /** One of several, chosen or let go where it stands: the popover stays, and the option is the arrows' next start. */
  private toggle(index: number, item: ChoiceItem<V>): void {
    const selected = this.selected!;
    const chosen = !selected.has(item.value);
    if (chosen) {
      selected.add(item.value);
    } else {
      selected.delete(item.value);
    }
    this.mark(this.options[index], chosen);
    this.setActive(index);
    this.onToggle?.(item.value);
  }

  /** Where an arrow, Home or End leads from option `from`; `from` itself when nowhere. */
  private step(from: number, key: string): number {
    const last = this.options.length - 1;
    if (key === 'Home') {
      return 0;
    }
    if (key === 'End') {
      return last;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (this.mode !== 'grid') {
        return from;
      }
      return Math.min(last, Math.max(0, from + (key === 'ArrowRight' ? 1 : -1)));
    }
    const at = this.rows.findIndex(row => row.includes(from));
    const target = this.rows[at + (key === 'ArrowDown' ? 1 : -1)];
    if (!target) {
      return from;
    }
    return target[Math.min(this.rows[at].indexOf(from), target.length - 1)];
  }

  /**
   * Below the anchor, or above it when the window leaves less room below
   * than the popover wants and more above; then pulled in from whichever
   * window edge it would cross.
   */
  private position(): void {
    const anchor = this.anchor.getBoundingClientRect();
    const style = this.element.style;
    style.minWidth = `${Math.round(anchor.width)}px`;
    // Measured unconstrained from the corner: a fixed box shrinks to the
    // room right of wherever it stood.
    style.maxHeight = '';
    style.left = '0px';
    style.top = '0px';
    style.bottom = '';
    const natural = this.element.getBoundingClientRect();
    const wanted = Math.min(natural.height, MAX_HEIGHT);
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const flipped = below < wanted && above > below;
    const room = Math.max(flipped ? above : below, MIN_HEIGHT);
    style.maxHeight = `${Math.round(Math.min(room, MAX_HEIGHT))}px`;
    if (flipped) {
      // Hung by its bottom edge, so a search that shortens the list keeps it on the anchor.
      style.top = '';
      style.bottom = `${Math.round(window.innerHeight - anchor.top + GAP)}px`;
    } else {
      style.top = `${Math.round(anchor.bottom + GAP)}px`;
    }
    this.element.dataset.placement = flipped ? 'above' : 'below';
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - natural.width - EDGE));
    style.left = `${Math.round(left)}px`;
  }

  private readonly onClick = (e: MouseEvent): void => {
    const option = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (option && this.list.contains(option)) {
      this.choose(Number(option.dataset.index));
    }
  };

  /**
   * Arrows, Home/End, Enter/Space and Tab; anything typed goes to the search
   * box. A key pressed in the popover is the popover's alone: an option is
   * no text field, so the page's shortcuts (a window listener) would
   * otherwise take a letter typed over it as a chord.
   */
  private readonly onPanelKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      // Focus goes back to the anchor first, so the browser's own Tab leaves from there.
      this.close();
      this.anchor.focus({ preventScroll: true });
      return;
    }
    if (e.target === this.searchInput) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusOption(Math.max(this.active, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.choose(Math.max(this.active, 0));
      }
      return;
    }
    const from = this.options.indexOf(e.target as HTMLElement);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.choose(from);
      return;
    }
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (from >= 0) {
        this.focusOption(this.step(from, e.key));
      } else {
        this.focusOption(Math.max(this.active, 0));
      }
      return;
    }
    // A printable key (or Backspace) is for the search box: focused now, it
    // receives the key's own input.
    const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (this.searchInput && (typed || e.key === 'Backspace')) {
      this.searchInput.focus({ preventScroll: true });
    }
  };

  /** Escape closes the popover only — a dialog under it stays. */
  private readonly onDocumentKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.close();
    this.anchor.focus({ preventScroll: true });
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    const target = e.target as Node;
    // A press on the anchor is the anchor's to answer (it toggles).
    if (!this.element.contains(target) && !this.anchor.contains(target)) {
      this.swallowPress(e);
      this.close();
    }
  };

  /**
   * The press that dismisses the popover does nothing else, as with a native
   * select's list: it is no pick in the viewport and no press on the control
   * under it. Stopped here, with what the same press sends after it, through
   * its click; a press that ends in no click (a drag) is let go at the next one.
   */
  private swallowPress(e: PointerEvent): void {
    const FOLLOWING = ['pointerup', 'mousedown', 'mouseup', 'click'];
    const release = (): void => {
      for (const type of FOLLOWING) {
        document.removeEventListener(type, swallow, true);
      }
      document.removeEventListener('pointerdown', release, true);
    };
    const swallow = (following: Event): void => {
      following.preventDefault();
      following.stopPropagation();
      if (following.type === 'click') {
        release();
      }
    };
    e.preventDefault();
    e.stopPropagation();
    for (const type of FOLLOWING) {
      document.addEventListener(type, swallow, true);
    }
    document.addEventListener('pointerdown', release, true);
  }

  /** A wheel or scroll elsewhere moves what the popover hangs off. */
  private readonly onMovedUnder = (e: Event): void => {
    if (!(e.target instanceof Node) || !this.element.contains(e.target)) {
      this.close();
    }
  };

  private readonly onResize = (): void => {
    this.position();
  };
}
