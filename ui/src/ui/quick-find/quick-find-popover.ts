import type { HubSearchRow } from '../../api';
import type { HubSearchSnapshot } from '../hub/hub-panel-state';
import { HubIcons, HubImage } from '../hub/hub-icons';
import { ICON_PIN, ICON_PINNED_OFF } from '../icons';
import { DEFAULT_ICON_SRC } from '../object-icons';
import { QuickFindPins } from './quick-find-pins';
import type { QuickFindTool, ToolIndex } from './tool-index';

/** The hub, as the popover reaches it: a search of its own, and the Hub panel to hand a package or a query to. */
export type QuickFindHub = {
  /** A `HubPanelState` of the popover's own, so its lookups never move the Hub panel's results. */
  state: {
    readonly snapshot: HubSearchSnapshot;
    setQuery(q: string): void;
    cancel(): void;
    subscribe(listener: (snapshot: HubSearchSnapshot) => void): () => void;
  };
  /** Open the Hub panel on a package's detail. */
  openPackage(name: string): void;
  /** Open the Hub panel on a search for `q`. */
  searchHub(q: string): void;
};

export type QuickFindDeps = {
  index: ToolIndex;
  pins: QuickFindPins;
  /** Absent: the empty result says so and offers nothing further. */
  hub?: QuickFindHub | null;
  /** Where the popover mounts (the page body: the bars clip their overflow). */
  host?: HTMLElement;
};

/** One thing the arrow keys can land on and Enter can run. */
type Item = { el: HTMLElement; run(): void; disabled: boolean };

/** Clearance from the window's edges, in pixels. */
const EDGE = 8;
/** How far the popover's corner sits from the pointer that opened it: the field starts under the cursor. */
const POINTER_INSET = 20;
/** Gap under a button that opened it. */
const GAP = 6;
/** Most hub packages suggested under an empty result. */
const HUB_ROWS = 3;

// Solid `bg-base-100` like every popup menu (menu-styles.ts): it opens over
// the viewport and over panels full of text, which must not read through.
const ROOT =
  'fixed z-[1200] w-[300px] max-w-[calc(100vw-16px)] flex flex-col bg-base-100 text-base-content '
  + 'border border-base-content/10 rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.4)] overflow-hidden select-none '
  + 'animate-[quick-find-in_0.12s_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none';
const FIELD_ROW = 'flex items-center gap-2 h-10 px-3 border-b border-base-content/10 shrink-0';
const FIELD = 'grow min-w-0 bg-transparent outline-none text-[13px] text-base-content placeholder:text-base-content/40';
const BODY = 'min-h-0 overflow-y-auto p-1.5';
/** Three tiles across, the Custom dropdown's grid. */
const GRID = 'grid grid-cols-3 gap-1';
// The toolbar's own idle and armed looks, stretched to the tile.
const TILE_SHAPE = 'btn btn-sm h-auto w-full min-w-0 flex-col gap-1 px-1 py-2';
const TILE_BASE = `${TILE_SHAPE} btn-ghost text-base-content/70`;
const TILE_ACTIVE = `${TILE_SHAPE} btn-soft btn-primary`;
const TILE_ICON = 'w-7 h-7 object-contain shrink-0';
/** The tile under the pointer while it is dragged to another slot. */
const TILE_DRAGGING = 'opacity-60 rounded-md ring-1 ring-primary/40';
/** How far the pointer travels before a press on a tile is a drag, not a click, in pixels. */
const DRAG_SLOP = 4;
const TILE_LABEL = 'block max-w-full truncate text-[11px] leading-tight';
const ROW = 'group/row relative flex items-center gap-2.5 w-full pl-2 pr-1 py-1.5 rounded text-left text-[13px] text-base-content/80 cursor-pointer';
const ROW_ICON = 'size-5 object-contain shrink-0';
/** The highlight the arrow keys and the pointer share: the menus' hover tint. */
const HIGHLIGHT = 'bg-base-content/[0.08]';
const PIN_BUTTON = 'btn btn-ghost btn-xs btn-square size-5 min-h-0 shrink-0 text-base-content/45 hover:text-base-content [&>svg]:size-3.5';
const NOTICE = 'px-2 py-2 text-[12px] leading-snug text-base-content/55';
const HUB_HEADING = 'px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide text-base-content/40 whitespace-nowrap';
const HUB_ROW = 'group/row flex items-center gap-2.5 w-full px-2 py-1.5 rounded text-left cursor-pointer';
const SKELETON = 'h-8 mx-2 my-1.5 rounded bg-base-content/[0.06] animate-pulse motion-reduce:animate-none';

/** Where the pointer last was over the page: where a keyboard-opened popover appears. */
let lastPointer: { x: number; y: number } | null = null;
let pointerTracked = false;

function trackPointer(): void {
  if (pointerTracked || typeof window === 'undefined') {
    return;
  }
  pointerTracked = true;
  window.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  }, { passive: true });
}

/**
 * Quick Find: the tool search every CAD application has under one key. <kbd>S</kbd>
 * (or the toolbar's Find button) opens it where the pointer is, with a
 * search field and the user's six pinned tools as tiles ({@link QuickFindPins});
 * typing lists every tool on the current bench that matches, by name, by
 * what other applications call it, or by what its tooltip says, with its
 * letter chord. Enter (or a click) runs the first or the highlighted one
 * exactly as its toolbar button would, and the popover is gone. A pin on
 * each tile and row keeps a tool in the six or lets it go.
 *
 * With nothing matching, and a hub to ask, the popover looks the words up on
 * FluidCAD Hub ({@link QuickFindHub}): up to three packages, each opening its
 * detail in the Hub panel, and a row that takes the whole search there.
 *
 * It closes on Escape, on a press or a wheel anywhere else, and after a tool
 * runs. The field keeps focus throughout: the highlight is virtual, so the
 * letters a user keeps typing land in the search.
 */
export class QuickFindPopover {
  readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly body: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly host: HTMLElement;
  private opened = false;
  private items: Item[] = [];
  private highlighted = -1;
  /** The words the hub was last asked about, so an answer for another query is not shown. */
  private hubQuery: string | null = null;
  /** A press on a pinned tile, until it is released: a drag once the pointer has moved {@link DRAG_SLOP}. */
  private drag: { id: string; cell: HTMLElement; pointerId: number; x: number; y: number; active: boolean } | null = null;
  /** The press just released was a drag: the click that follows it is not a pick. */
  private suppressClick = false;
  private readonly unsubscribe: (() => void)[] = [];
  private static sequence = 0;
  private readonly listboxId = `quick-find-list-${++QuickFindPopover.sequence}`;

  constructor(private readonly deps: QuickFindDeps) {
    trackPointer();
    this.host = deps.host ?? document.body;

    this.el = document.createElement('div');
    this.el.className = ROOT;
    this.el.dataset.role = 'quick-find';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Find a tool');

    const field = document.createElement('label');
    field.className = FIELD_ROW;
    field.appendChild(HubIcons.span(HubIcons.SEARCH, '[&>svg]:size-4 text-base-content/45'));
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.dataset.ref = 'query';
    this.input.className = FIELD;
    this.input.placeholder = 'Find a tool';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', this.listboxId);
    this.input.setAttribute('aria-label', 'Find a tool');
    this.input.addEventListener('input', () => this.render());
    const esc = document.createElement('kbd');
    esc.className = 'kbd kbd-xs text-base-content/50';
    esc.textContent = 'esc';
    esc.setAttribute('aria-hidden', 'true');
    field.append(this.input, esc);

    this.body = document.createElement('div');
    this.body.className = BODY;
    this.body.dataset.ref = 'body';
    this.body.id = this.listboxId;
    this.body.setAttribute('role', 'listbox');
    this.body.setAttribute('aria-label', 'Tools');

    this.status = document.createElement('div');
    this.status.className = 'sr-only';
    this.status.setAttribute('role', 'status');

    this.el.append(field, this.body, this.status);
    this.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    // A press on a tile must not pull focus off the field (the letters keep landing in it).
    this.el.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) {
        e.preventDefault();
      }
    });

    this.unsubscribe.push(deps.index.subscribe(() => {
      if (this.opened) {
        this.render();
      }
    }));
    if (deps.hub) {
      this.unsubscribe.push(deps.hub.state.subscribe(() => {
        if (this.opened && this.hubQuery !== null) {
          this.render();
        }
      }));
    }
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** The words in the field. */
  get query(): string {
    return this.input.value;
  }

  /** Open where the pointer last was (the keyboard's way in), or close if open. */
  toggleAtPointer(): void {
    if (this.opened) {
      this.close();
      return;
    }
    const point = lastPointer ?? { x: window.innerWidth / 2, y: Math.min(window.innerHeight / 3, 200) };
    this.openAt(point);
  }

  /** Open under a button (the toolbar's Find), or close if open. */
  toggleBelow(anchor: HTMLElement): void {
    if (this.opened) {
      this.close();
      return;
    }
    this.mount();
    const rect = anchor.getBoundingClientRect();
    this.place(rect.left + rect.width / 2 - this.el.offsetWidth / 2, rect.bottom + GAP);
  }

  /** Open with the popover's corner just off `point`, pulled in from the window's edges. */
  openAt(point: { x: number; y: number }): void {
    if (this.opened) {
      return;
    }
    this.mount();
    this.place(point.x - POINTER_INSET, point.y - POINTER_INSET);
  }

  close(): void {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    this.endDrag();
    this.dropHubLookup();
    this.el.remove();
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('wheel', this.onWheel, { capture: true });
    window.removeEventListener('resize', this.onResize);
    this.input.blur();
  }

  destroy(): void {
    this.close();
    for (const off of this.unsubscribe.splice(0)) {
      off();
    }
  }

  // ---------------------------------------------------------------------------
  // Opening
  // ---------------------------------------------------------------------------

  private mount(): void {
    this.opened = true;
    this.input.value = '';
    this.highlighted = -1;
    this.host.appendChild(this.el);
    this.render();
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);
    this.input.focus();
  }

  /** Put the top-left corner at (`left`, `top`), kept inside the window; the body scrolls past the room below. */
  private place(left: number, top: number): void {
    const width = this.el.offsetWidth || 300;
    const x = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
    let y = Math.max(EDGE, top);
    const height = this.el.offsetHeight;
    if (height > 0 && y + height > window.innerHeight - EDGE) {
      y = Math.max(EDGE, window.innerHeight - height - EDGE);
    }
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.el.style.maxHeight = `${Math.max(Math.round(window.innerHeight - y - EDGE), 120)}px`;
    this.anchor = { left: x, top: y };
  }

  private anchor: { left: number; top: number } | null = null;

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const query = this.input.value.trim();
    this.items = [];
    const children: HTMLElement[] = [];
    if (query === '') {
      this.dropHubLookup();
      children.push(...this.renderPinned());
      // A highlight the keyboard holds on a tile survives the redraw (a pin
      // just moved); none before typing, so Enter does nothing yet.
      this.highlighted = this.highlighted < this.items.length ? this.highlighted : -1;
    } else {
      const matches = this.deps.index.search(query);
      if (matches.length > 0) {
        this.dropHubLookup();
        children.push(...matches.map(({ tool }) => this.row(tool)));
        this.status.textContent = `${matches.length} ${matches.length === 1 ? 'tool' : 'tools'}`;
        this.highlighted = Math.min(Math.max(this.highlighted, 0), this.items.length - 1);
      } else {
        children.push(...this.renderEmpty(query));
        this.highlighted = this.items.length > 0 ? Math.min(Math.max(this.highlighted, 0), this.items.length - 1) : -1;
      }
    }
    this.body.replaceChildren(...children);
    this.syncHighlight();
  }

  /**
   * No hub lookup wanted (a tool matches, the field is empty, the popover
   * closed): nothing pending or in flight, and the words forgotten, so the
   * same words typed again later ask again.
   */
  private dropHubLookup(): void {
    this.hubQuery = null;
    const state = this.deps.hub?.state;
    if (state) {
      state.setQuery('');
      state.cancel();
    }
  }

  /** The pinned tiles alone (no heading: the pins on the tiles say what they are), or what to do with none. */
  private renderPinned(): HTMLElement[] {
    const shown = this.deps.pins.shown();
    if (shown.length === 0) {
      const notice = document.createElement('p');
      notice.className = NOTICE;
      notice.dataset.ref = 'no-pins';
      notice.textContent = 'Nothing pinned here. Type a tool’s name, then pin it to keep it in this list.';
      this.status.textContent = 'No pinned tools';
      return [notice];
    }
    const grid = document.createElement('div');
    grid.className = GRID;
    grid.dataset.ref = 'pinned';
    grid.setAttribute('aria-label', 'Pinned tools');
    grid.append(...shown.map(tool => this.tile(tool)));
    this.status.textContent = `${shown.length} pinned ${shown.length === 1 ? 'tool' : 'tools'}`;
    return [grid];
  }

  /** A pinned tool as a tile: its icon over its name, the unpin at its corner. */
  private tile(tool: QuickFindTool): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'group/tile relative min-w-0 flex';
    cell.dataset.tool = tool.id;
    const disabled = tool.isDisabled?.() === true;
    const button = document.createElement('div');
    button.className = `${tool.isActive?.() ? TILE_ACTIVE : TILE_BASE}${disabled ? ' opacity-40' : ''}`;
    button.setAttribute('role', 'option');
    button.id = `${this.listboxId}-${this.items.length}`;
    button.setAttribute('aria-selected', 'false');
    if (disabled) {
      button.setAttribute('aria-disabled', 'true');
    }
    button.title = disabled ? (tool.disabledReason?.() ?? `${tool.label} isn’t available right now`) : tool.tip;
    button.appendChild(this.icon(tool, TILE_ICON));
    const label = document.createElement('span');
    label.className = TILE_LABEL;
    label.textContent = tool.label;
    button.appendChild(label);
    const pin = this.pinButton(tool);
    pin.className = `${PIN_BUTTON} absolute top-0.5 right-0.5 opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 group-data-[highlighted]/tile:opacity-100`;
    cell.append(button, pin);
    this.listen(cell, button, { el: cell, run: () => this.run(tool), disabled });
    // A tile drags to another slot (the pins' order is the user's); the pin
    // at its corner is a button of its own and never starts one.
    cell.classList.add('touch-none');
    cell.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('[data-ref="pin"]')) {
        return;
      }
      this.beginDrag(tool.id, cell, e);
    });
    return cell;
  }

  // ---------------------------------------------------------------------------
  // Reordering the pins
  // ---------------------------------------------------------------------------

  private beginDrag(id: string, cell: HTMLElement, e: PointerEvent): void {
    this.endDrag();
    this.drag = { id, cell, pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false };
    document.addEventListener('pointermove', this.onDragMove, true);
    document.addEventListener('pointerup', this.onDragEnd, true);
    document.addEventListener('pointercancel', this.onDragCancel, true);
  }

  /** The pointer moved with a tile pressed: past the slop it is a drag, and the tile follows it from slot to slot. */
  private readonly onDragMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) {
        return;
      }
      drag.active = true;
      drag.cell.classList.add(...TILE_DRAGGING.split(' '));
      document.body.style.cursor = 'grabbing';
    }
    e.preventDefault();
    const grid = drag.cell.parentElement;
    if (!grid) {
      return;
    }
    const cells = [...grid.children] as HTMLElement[];
    const over = cells.find((other) => {
      if (other === drag.cell) {
        return false;
      }
      const r = other.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
    });
    if (!over) {
      return;
    }
    // The dragged tile takes the slot under the pointer; the tiles between shift one slot toward where it came from.
    if (cells.indexOf(drag.cell) < cells.indexOf(over)) {
      over.after(drag.cell);
    } else {
      over.before(drag.cell);
    }
  };

  /** Released: a drag stores the grid's new order; a press that never moved stays a click. */
  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const grid = drag.cell.parentElement;
    const active = drag.active;
    this.endDrag();
    if (!active) {
      return;
    }
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    if (grid) {
      this.deps.pins.reorder(([...grid.children] as HTMLElement[]).map(cell => cell.dataset.tool!));
    }
    this.render();
  };

  private readonly onDragCancel = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.cancelDrag();
    }
  };

  /** Drop the drag and put the tiles back where the pins say. */
  private cancelDrag(): void {
    const active = this.drag?.active ?? false;
    this.endDrag();
    if (active) {
      this.render();
    }
  }

  private endDrag(): void {
    if (!this.drag) {
      return;
    }
    this.drag.cell.classList.remove(...TILE_DRAGGING.split(' '));
    document.body.style.cursor = '';
    this.drag = null;
    document.removeEventListener('pointermove', this.onDragMove, true);
    document.removeEventListener('pointerup', this.onDragEnd, true);
    document.removeEventListener('pointercancel', this.onDragCancel, true);
  }

  /**
   * The keyboard's reorder: the highlighted tile moves `delta` slots (one
   * with Alt+Left/Right, a row of three with Alt+Up/Down) and stays
   * highlighted where it lands.
   */
  private moveHighlightedPin(delta: number): void {
    const from = this.highlighted;
    const ids = this.deps.pins.shown().map(tool => tool.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) {
      return;
    }
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    this.deps.pins.reorder(ids);
    this.highlighted = to;
    this.render();
  }

  /** A matching tool as a row: icon, name, what it does or where it lives, its chord, its pin. */
  private row(tool: QuickFindTool): HTMLElement {
    const disabled = tool.isDisabled?.() === true;
    const row = document.createElement('div');
    row.className = `${ROW}${disabled ? ' opacity-40' : ''}`;
    row.dataset.tool = tool.id;
    row.setAttribute('role', 'option');
    row.id = `${this.listboxId}-${this.items.length}`;
    row.setAttribute('aria-selected', 'false');
    if (disabled) {
      row.setAttribute('aria-disabled', 'true');
      row.title = tool.disabledReason?.() ?? `${tool.label} isn’t available right now`;
    }
    row.appendChild(this.icon(tool, ROW_ICON));
    const label = document.createElement('span');
    label.className = `shrink-0 ${tool.isActive?.() ? 'text-primary' : ''}`;
    label.textContent = tool.label;
    const detail = document.createElement('span');
    detail.className = 'grow min-w-0 truncate text-[11px] text-base-content/45';
    detail.textContent = tool.tip !== tool.label ? tool.tip : tool.bench;
    row.append(label, detail);
    if (tool.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd kbd-xs shrink-0';
      kbd.textContent = tool.shortcut;
      row.appendChild(kbd);
    }
    const pin = this.pinButton(tool);
    const pinned = this.deps.pins.isPinned(tool.id);
    pin.className = `${PIN_BUTTON} ${pinned ? 'opacity-60' : 'opacity-0'} group-hover/row:opacity-100 focus-visible:opacity-100 group-data-[highlighted]/row:opacity-100`;
    row.appendChild(pin);
    this.listen(row, row, { el: row, run: () => this.run(tool), disabled });
    return row;
  }

  /** Nothing on the bar answers `query`: say so, then what the hub has. */
  private renderEmpty(query: string): HTMLElement[] {
    const notice = document.createElement('p');
    notice.className = NOTICE;
    notice.dataset.ref = 'no-match';
    notice.textContent = `No tool matches “${query}”.`;
    this.status.textContent = notice.textContent;
    const hub = this.deps.hub;
    if (!hub) {
      return [notice];
    }
    const normalized = query.toLowerCase();
    if (this.hubQuery !== normalized) {
      this.hubQuery = normalized;
      hub.state.setQuery(query);
    }
    const heading = document.createElement('div');
    heading.className = HUB_HEADING;
    heading.textContent = 'On FluidCAD Hub';
    heading.setAttribute('role', 'presentation');
    const block = document.createElement('div');
    block.dataset.ref = 'hub';
    block.append(heading, ...this.renderHub(query, hub));
    return [notice, block];
  }

  private renderHub(query: string, hub: QuickFindHub): HTMLElement[] {
    const { mode, answer, error } = hub.state.snapshot;
    const current = answer !== null && answer.request.q.trim().toLowerCase() === query.toLowerCase();
    if (mode === 'offline' || mode === 'error') {
      const notice = document.createElement('p');
      notice.className = NOTICE;
      notice.dataset.ref = 'hub-notice';
      notice.textContent = mode === 'offline' ? 'The hub doesn’t answer.' : (error ?? 'The hub refused the search.');
      return [notice];
    }
    if (mode !== 'results' || !current) {
      const rows: HTMLElement[] = [];
      for (let i = 0; i < 2; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = SKELETON;
        skeleton.dataset.ref = 'hub-loading';
        skeleton.setAttribute('aria-hidden', 'true');
        rows.push(skeleton);
      }
      return rows;
    }
    if (answer.results.length === 0) {
      const notice = document.createElement('p');
      notice.className = NOTICE;
      notice.dataset.ref = 'hub-notice';
      notice.textContent = 'Nothing on the hub either.';
      return [notice];
    }
    const rows = answer.results.slice(0, HUB_ROWS).map(row => this.hubRow(row, hub));
    const more = document.createElement('div');
    more.className = `${HUB_ROW} text-[12px] text-base-content/70`;
    more.dataset.ref = 'search-hub';
    more.setAttribute('role', 'option');
    more.id = `${this.listboxId}-${this.items.length}`;
    more.setAttribute('aria-selected', 'false');
    // The icon sits where the rows above keep their card, so the column lines up.
    more.appendChild(HubIcons.span(HubIcons.SEARCH, 'size-8 items-center justify-center [&>svg]:size-4 text-base-content/45'));
    const text = document.createElement('span');
    text.className = 'truncate';
    text.textContent = `Search the hub for “${query}”`;
    more.appendChild(text);
    this.listen(more, more, { el: more, run: () => this.leaveFor(() => hub.searchHub(query)), disabled: false });
    rows.push(more);
    return rows;
  }

  /** One hub package: its card, its name, a line of its description. */
  private hubRow(row: HubSearchRow, hub: QuickFindHub): HTMLElement {
    const el = document.createElement('div');
    el.className = HUB_ROW;
    el.dataset.package = row.fullName;
    el.setAttribute('role', 'option');
    el.id = `${this.listboxId}-${this.items.length}`;
    el.setAttribute('aria-selected', 'false');
    el.title = `Open ${row.fullName} in the Hub panel`;
    const thumb = document.createElement('span');
    thumb.className = 'size-8 shrink-0 rounded bg-base-200 border border-base-content/[0.06] overflow-hidden grid place-items-center';
    const placeholder = () => HubIcons.span(HubIcons.BOX, '[&>svg]:size-4 text-base-content/30');
    thumb.appendChild(row.cardImageUrl ? HubImage.create(row.cardImageUrl, 'size-full object-cover', placeholder) : placeholder());
    const text = document.createElement('span');
    text.className = 'min-w-0 flex flex-col';
    const name = document.createElement('span');
    name.className = 'font-mono text-[12px] text-base-content/85 truncate';
    name.textContent = row.fullName;
    text.appendChild(name);
    if (row.description) {
      const description = document.createElement('span');
      description.className = 'text-[11px] text-base-content/50 truncate';
      description.textContent = row.description;
      text.appendChild(description);
    }
    el.append(thumb, text);
    this.listen(el, el, { el, run: () => this.leaveFor(() => hub.openPackage(row.fullName)), disabled: false });
    return el;
  }

  private icon(tool: QuickFindTool, cls: string): HTMLElement {
    if (tool.iconSrc) {
      const img = document.createElement('img');
      img.src = tool.iconSrc;
      img.alt = '';
      img.className = cls;
      img.addEventListener('error', () => {
        img.src = DEFAULT_ICON_SRC;
      }, { once: true });
      return img;
    }
    const span = document.createElement('span');
    span.className = `${cls} inline-flex items-center justify-center [&>svg]:size-full`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = tool.iconSvg ?? '';
    return span;
  }

  /** The pin toggle: unpin a pinned tool, pin another while there is room. */
  private pinButton(tool: QuickFindTool): HTMLButtonElement {
    const pinned = this.deps.pins.isPinned(tool.id);
    const full = !pinned && this.deps.pins.full;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = 'pin';
    button.dataset.pinned = String(pinned);
    button.tabIndex = -1;
    button.innerHTML = pinned ? ICON_PINNED_OFF : ICON_PIN;
    button.disabled = full;
    button.title = pinned
      ? 'Unpin'
      : full
        ? `${QuickFindPins.LIMIT} tools are pinned here. Unpin one to make room.`
        : 'Pin to Quick Find';
    button.setAttribute('aria-label', pinned ? `Unpin ${tool.label}` : `Pin ${tool.label}`);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pinned) {
        this.deps.pins.unpin(tool.id);
      } else {
        this.deps.pins.pin(tool.id);
      }
      this.render();
    });
    return button;
  }

  /** Wire an item: a click runs it, the pointer over it highlights it. */
  private listen(hit: HTMLElement, target: HTMLElement, item: Item): void {
    const index = this.items.length;
    this.items.push(item);
    target.addEventListener('click', (e) => {
      if (this.suppressClick) {
        // The click that ends a drag: consumed, not a pick.
        this.suppressClick = false;
        return;
      }
      if ((e.target as Element).closest('[data-ref="pin"]')) {
        return;
      }
      if (!item.disabled) {
        item.run();
      }
    });
    hit.addEventListener('pointerenter', () => {
      this.highlighted = index;
      this.syncHighlight();
    });
  }

  private syncHighlight(): void {
    this.items.forEach((item, i) => {
      const on = i === this.highlighted;
      item.el.classList.toggle(HIGHLIGHT, on);
      item.el.toggleAttribute('data-highlighted', on);
      const option = item.el.getAttribute('role') === 'option' ? item.el : item.el.querySelector('[role="option"]');
      option?.setAttribute('aria-selected', String(on));
    });
    const current = this.items[this.highlighted];
    const option = current
      ? (current.el.getAttribute('role') === 'option' ? current.el : current.el.querySelector('[role="option"]'))
      : null;
    if (option?.id) {
      this.input.setAttribute('aria-activedescendant', option.id);
      (option as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  // ---------------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------------

  /** Close, then do what the toolbar button would: the tool's dialog opens over a quiet page. */
  private run(tool: QuickFindTool): void {
    if (tool.isDisabled?.()) {
      return;
    }
    this.leaveFor(() => tool.run());
  }

  private leaveFor(action: () => void): void {
    this.close();
    action();
  }

  private move(delta: number): void {
    if (this.items.length === 0) {
      return;
    }
    const n = this.items.length;
    this.highlighted = this.highlighted < 0
      ? (delta > 0 ? 0 : n - 1)
      : (((this.highlighted + delta) % n) + n) % n;
    this.syncHighlight();
  }

  private onKeyDown(e: KeyboardEvent): void {
    // The field is the one key target; nothing under the popover sees these.
    e.stopPropagation();
    const inGrid = this.input.value.trim() === '';
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (this.drag?.active) {
          this.cancelDrag();
          return;
        }
        this.close();
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (inGrid && e.altKey) {
          this.moveHighlightedPin(3);
          return;
        }
        this.move(inGrid ? 3 : 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (inGrid && e.altKey) {
          this.moveHighlightedPin(-3);
          return;
        }
        this.move(inGrid ? -3 : -1);
        return;
      case 'ArrowRight':
        if (inGrid) {
          e.preventDefault();
          if (e.altKey) {
            this.moveHighlightedPin(1);
          } else {
            this.move(1);
          }
        }
        return;
      case 'ArrowLeft':
        if (inGrid) {
          e.preventDefault();
          if (e.altKey) {
            this.moveHighlightedPin(-1);
          } else {
            this.move(-1);
          }
        }
        return;
      case 'Home':
        if (this.items.length > 0 && inGrid) {
          e.preventDefault();
          this.highlighted = 0;
          this.syncHighlight();
        }
        return;
      case 'End':
        if (this.items.length > 0 && inGrid) {
          e.preventDefault();
          this.highlighted = this.items.length - 1;
          this.syncHighlight();
        }
        return;
      case 'Enter': {
        e.preventDefault();
        const item = this.items[this.highlighted] ?? (inGrid ? null : this.items[0]);
        if (item && !item.disabled) {
          item.run();
        }
        return;
      }
      default:
        return;
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node)) {
      this.close();
    }
  };

  /** A wheel elsewhere moves what the popover sits over (the view zooms, the bar scrolls). */
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.el.contains(e.target as Node)) {
      this.close();
    }
  };

  private readonly onResize = (): void => {
    if (this.anchor) {
      this.place(this.anchor.left, this.anchor.top);
    }
  };
}
