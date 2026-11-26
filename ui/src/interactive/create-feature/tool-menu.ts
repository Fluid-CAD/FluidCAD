import { ICON_CHEVRON_DOWN } from '../../ui/icons';
import { iconUrl } from '../../ui/icon-url';
import type { Navbar } from '../../ui/navbar';
import type { NavbarMode } from '../../ui/navbar/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { isShownOnBar, toolIndex, type QuickFindTool } from '../../ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from '../../ui/toolbar-styles';
import { viewportChrome } from '../../ui/viewport-chrome';
import type { FeatureLauncher } from './feature-button';
import type { SketchHideable } from './finish-sketch-button';

/** Where a toolbar dropdown sits and what its button says. */
export type ToolMenuButtonOptions = {
  /** The navbar group the button sits in. */
  group: string;
  /** The navbar group the button's group goes ahead of, once that one is registered. */
  before?: string;
  /** The bench the button and its dropdown show on (default `'part'`). */
  mode?: NavbarMode;
  /** The button's label on the toolbar. */
  label: string;
  /** The button's icon, a toolbar icon name for `iconUrl`. */
  icon: string;
  /** The button's tooltip and aria label. */
  tip: string;
  /** The button wrapper's `data-tool`. */
  tool: string;
  /** The dropdown's `data-role` (default `<tool>-menu`). */
  role?: string;
  /** What the dropdown says with nothing listed. */
  emptyText: string;
  /** Columns of the grid (default two). */
  columns?: 2 | 3;
};

/** Where a {@link ToolMenu} sits, what it says, and how Quick Find lists its tools. */
export type ToolMenuOptions = ToolMenuButtonOptions & {
  /** The Quick Find bench its tools list under: `'Curves'`, `'Surfaces'`. */
  bench: string;
  /** The Quick Find id's head: `<prefix>:<cell id>` (`'part'` for built-in tools). */
  quickFindPrefix: string;
};

/** What every cell of a toolbar dropdown shows. */
export type ToolMenuCellLook = {
  /** The tool's id; null for an entry that has none. */
  id: string | null;
  label: string;
  iconSrc: string;
  /** The cell's aria label, and its tooltip when there is no {@link description}. */
  tip: string;
  /** What the tool does: the cell's tooltip in place of {@link tip}. */
  description?: string;
  /** An entry that can't be offered: greyed, its tooltip saying why. */
  disabled?: boolean;
};

/** How one tool shows in a {@link ToolMenu}. */
export type ToolMenuCellSpec = ToolMenuCellLook & {
  /** The tool's slug (`helix`, `intersection-curve`): the cell's `data-tool` and its Quick Find id's tail. */
  id: string;
  /** Lower first; cells without one follow in insertion order. */
  order?: number;
};

/** What a cell tells its dropdown. */
export type ToolMenuCellEvents<C> = {
  press(cell: C): void;
  activeChange(): void;
  remove(cell: C): void;
};

// The dropdown hangs off the button like the sketch toolbar's option menus
// (same surface, border and shadow), but from the page body: the bar clips
// its track sideways, and a grid near either end of it must stay whole.
const PANEL =
  'fixed z-[1200] p-1.5 overflow-y-auto max-w-[calc(100vw-16px)] '
  + 'panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
/** The grid by its column count: columns that narrow (labels truncating) only when the window can't fit them. */
const GRIDS: Record<2 | 3, string> = {
  2: 'grid grid-cols-[repeat(2,minmax(0,7rem))] gap-1',
  3: 'grid grid-cols-[repeat(3,minmax(0,5.5rem))] gap-1',
};
// The toolbar's own idle and armed looks, stretched to the cell.
const CELL_SHAPE = 'btn btn-sm h-auto w-full min-w-0 flex-col gap-1 px-1 py-2';
const CELL_BASE = `${CELL_SHAPE} btn-ghost text-base-content/70`;
const CELL_ACTIVE = `${CELL_SHAPE} btn-soft btn-primary`;
const CELL_LABEL = 'block max-w-full truncate text-[11px] leading-tight';

/** Clearance from the window's edges, in pixels. */
const EDGE = 8;
/** Gap between the button and the dropdown, in pixels. */
const GAP = 6;

/**
 * One tool in a dropdown's grid: its icon over its label, the click that
 * opens its dialog, and the armed styling while that dialog is open. The
 * dialog drives it as it would its own toolbar button.
 */
export class ToolMenuCell<S extends ToolMenuCellLook = ToolMenuCellSpec> implements FeatureLauncher {
  onClick?: () => void;

  /** The grid cell — it carries the tooltip, so a greyed entry still explains itself. */
  readonly el: HTMLDivElement;
  protected readonly button: HTMLButtonElement;
  protected readonly label: HTMLSpanElement;
  private _active = false;
  /** Greyed by its dialog ({@link setDisabled}): the tool has nothing to work on. */
  private _unavailable = false;

  constructor(
    readonly spec: S,
    tool: string | undefined,
    private readonly events: ToolMenuCellEvents<ToolMenuCell<S>>,
  ) {
    this.el = document.createElement('div');
    if (tool !== undefined) {
      this.el.dataset.tool = tool;
    }
    this.button = document.createElement('button');
    this.button.setAttribute('aria-label', spec.tip);
    this.button.disabled = this.disabled;
    this.button.innerHTML = `<img src="${spec.iconSrc}" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`;
    this.label = document.createElement('span');
    this.label.textContent = spec.label;
    this.button.appendChild(this.label);
    this.button.addEventListener('click', () => this.events.press(this));
    this.el.appendChild(this.button);
    this.syncClass();
    this.syncTip();
  }

  get active(): boolean {
    return this._active;
  }

  get disabled(): boolean {
    return this.spec.disabled === true || this._unavailable;
  }

  setActive(active: boolean): void {
    if (this._active === active) {
      return;
    }
    this._active = active;
    this.syncClass();
    this.events.activeChange();
  }

  setDisabled(disabled: boolean): void {
    if (this._unavailable === disabled) {
      return;
    }
    this._unavailable = disabled;
    this.button.disabled = this.disabled;
    this.syncClass();
  }

  /** Take the cell out of the menu for good. */
  remove(): void {
    this.events.remove(this);
  }

  protected syncClass(): void {
    const look = this._active ? CELL_ACTIVE : CELL_BASE;
    // A greyed cell lets the hover through to the cell, whose tooltip says why.
    this.button.className = `${look}${this.disabled ? ' pointer-events-none' : ''}`;
    this.label.className = CELL_LABEL;
    this.el.className = 'relative min-w-0 flex';
  }

  protected syncTip(): void {
    // A greyed entry's tip says why it can't be offered, so it wins.
    this.el.title = (!this.spec.disabled && this.spec.description) || this.spec.tip;
  }
}

/**
 * A toolbar button that opens a grid of tool cells under it: the dropdown
 * every toolbar menu shares. It closes on a cell's click, Escape, a press
 * or a wheel anywhere else, and whenever a dialog opens; it leaves the bar
 * while a sketch is up
 * ({@link setSketchHidden}), and reads as armed while one of its tools'
 * dialogs is open. Each cell is in Quick Find for as long as it is listed.
 *
 * What a menu lists, in what order, what its empty dropdown says and how
 * Quick Find names its tools are the subclass's: {@link ToolMenu} for the
 * built-in tool menus, `CustomFeaturesMenu` for the workspace's features.
 */
export abstract class ToolMenuBase<S extends ToolMenuCellLook, C extends ToolMenuCell<S>> implements SketchHideable {
  /** The dropdown just opened (its owner may refresh what it lists). */
  onOpen?: () => void;

  protected readonly wrap: HTMLSpanElement;
  protected readonly button: HTMLButtonElement;
  protected readonly panel: HTMLDivElement;
  protected readonly cells: C[] = [];
  /** The navbar group the button sits in. */
  protected readonly groupKey: string;
  protected readonly mode: NavbarMode;
  protected readonly emptyText: string;
  protected readonly gridClass: string;
  protected sketchHidden = false;
  /** Each cell's exit from the Quick Find index. */
  private readonly unindex = new Map<C, () => void>();
  private opened = false;
  /** The dialogs open when the dropdown opened — one more closes it. */
  private dialogsAtOpen: ReadonlySet<string> = new Set();

  constructor(protected readonly navbar: Navbar, options: ToolMenuButtonOptions) {
    this.groupKey = options.group;
    this.mode = options.mode ?? 'part';
    this.emptyText = options.emptyText;
    this.gridClass = GRIDS[options.columns ?? 2];
    const group = navbar.getGroup(this.groupKey)
      ?? navbar.addGroup(this.groupKey, { visible: false, mode: this.mode, before: options.before });

    this.button = document.createElement('button');
    this.button.className = TOOLBAR_BTN_BASE;
    this.button.setAttribute('aria-label', options.tip);
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.innerHTML =
      `<img src="${iconUrl(options.icon)}" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
      + `<span class="${TOOLBAR_BTN_LABEL} flex items-center gap-0.5"><span data-role="menu-label"></span>`
      + `<span class="[&>svg]:size-2.5" aria-hidden="true">${ICON_CHEVRON_DOWN}</span></span>`;
    this.button.querySelector<HTMLSpanElement>('[data-role="menu-label"]')!.textContent = options.label;
    this.button.addEventListener('click', () => this.toggle());
    this.wrap = document.createElement('span');
    this.wrap.className = 'tooltip tooltip-bottom shrink-0';
    this.wrap.dataset.tip = options.tip;
    this.wrap.dataset.tool = options.tool;
    this.wrap.appendChild(this.button);
    group.appendChild(this.wrap);

    this.panel = document.createElement('div');
    this.panel.className = PANEL;
    this.panel.dataset.role = options.role ?? `${options.tool}-menu`;
    // A click on a cell must not pull focus off the editor or the viewport.
    this.panel.addEventListener('mousedown', (e) => e.preventDefault());

    viewportChrome.subscribeDialogs((openIds) => {
      if ([...openIds].some(id => !this.dialogsAtOpen.has(id))) {
        this.close();
      }
    });
  }

  /**
   * List a tool; the cell stays until its `remove()`. The cell is the
   * launcher a dialog service opens from.
   */
  add(spec: S): C {
    const cell = this.createCell(spec, {
      press: (pressed) => {
        this.close();
        pressed.onClick?.();
      },
      activeChange: () => this.syncActive(),
      remove: (removed) => this.drop(removed as C),
    });
    this.cells.push(cell);
    this.unindex.set(cell, toolIndex.register(this.quickFindEntry(cell)));
    this.layout();
    return cell;
  }

  /** The cells in grid order. */
  get entries(): readonly C[] {
    return [...this.cells];
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Whether the button is on the bar. */
  get isVisible(): boolean {
    return !this.sketchHidden;
  }

  /** Armed: one of its listed tools' dialogs is open. */
  get isActive(): boolean {
    return this.cells.some(cell => cell.active);
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.isOpen || !this.isVisible) {
      return;
    }
    this.opened = true;
    this.dialogsAtOpen = viewportChrome.openDialogIds;
    document.body.appendChild(this.panel);
    this.position();
    this.button.setAttribute('aria-expanded', 'true');
    // The hover tooltip sits where the dropdown hangs.
    this.wrap.classList.remove('tooltip');
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);
    this.onOpen?.();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.opened = false;
    this.panel.remove();
    this.button.setAttribute('aria-expanded', 'false');
    this.wrap.classList.add('tooltip');
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('wheel', this.onWheel, { capture: true });
    window.removeEventListener('resize', this.onResize);
  }

  /** Off the bar while a sketch is up, like the create buttons — and the dropdown with it. */
  setSketchHidden(hidden: boolean): void {
    if (this.sketchHidden === hidden) {
      return;
    }
    this.sketchHidden = hidden;
    this.syncVisible();
  }

  /** The cell for `spec`, wired to `events`. */
  protected abstract createCell(spec: S, events: ToolMenuCellEvents<ToolMenuCell<S>>): C;

  /** How Quick Find lists a cell. */
  protected abstract quickFindEntry(cell: C): QuickFindTool;

  /** Order the cells and fill the dropdown, then bring the button in line with them. */
  protected abstract layout(): void;

  /** Whether the bar shows the button now: Quick Find's answer for a cell listed in the dropdown. */
  protected get buttonShown(): boolean {
    return isShownOnBar(this.wrap);
  }

  /** A grid of `cells`, in the order given. */
  protected grid(cells: readonly C[]): HTMLDivElement {
    const grid = document.createElement('div');
    grid.className = this.gridClass;
    grid.replaceChildren(...cells.map(cell => cell.el));
    return grid;
  }

  /** The button, the bar and an open dropdown after the cells changed. */
  protected settle(): void {
    this.syncActive();
    this.syncVisible();
    if (this.isOpen) {
      this.position();
    }
  }

  protected syncActive(): void {
    this.button.className = this.isActive ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
  }

  protected syncVisible(): void {
    // One vote, so a sketch hides the group whole — no empty group behind a divider.
    this.navbar.setGroupVisible(this.groupKey, this.isVisible);
    if (!this.isVisible) {
      this.close();
    }
  }

  private drop(cell: C): void {
    const index = this.cells.indexOf(cell);
    if (index < 0) {
      return;
    }
    this.cells.splice(index, 1);
    this.unindex.get(cell)?.();
    this.unindex.delete(cell);
    cell.el.remove();
    this.layout();
  }

  /**
   * Centred under the button, then pulled in from whichever window edge it
   * would cross; as tall as the window leaves below it, scrolling past that.
   */
  private position(): void {
    const anchor = this.button.getBoundingClientRect();
    const top = anchor.bottom + GAP;
    this.panel.style.top = `${Math.round(top)}px`;
    this.panel.style.maxHeight = `${Math.max(Math.round(window.innerHeight - top - EDGE), 96)}px`;
    // Measured from the left edge: a fixed box shrinks to the room right of
    // wherever it stood, so a stale offset would read a squeezed width.
    this.panel.style.left = '0px';
    const width = this.panel.offsetWidth;
    const centred = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.max(EDGE, Math.min(centred, window.innerWidth - width - EDGE));
    this.panel.style.left = `${Math.round(left)}px`;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const target = e.target as Node;
    if (!this.panel.contains(target) && !this.wrap.contains(target)) {
      this.close();
    }
  };

  /** Escape closes the dropdown only — an open dialog under it stays. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  /** A wheel elsewhere moves what the dropdown hangs off (the bar scrolls, the view zooms). */
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.panel.contains(e.target as Node)) {
      this.close();
    }
  };

  private readonly onResize = (): void => {
    this.position();
  };
}

/**
 * A toolbar dropdown of built-in tools (Curves, Surfaces): a two-column grid
 * in a fixed order — each cell's `order`, then insertion. Every tool in it is
 * a hand-wired feature whose dialog service opens from the cell
 * {@link add} returns, as it would from its own toolbar button. Quick Find
 * lists each cell as `<quickFindPrefix>:<id>` under the menu's bench, shown
 * while the menu's button is on the bar. The button stays on the bar with
 * nothing listed, its dropdown saying so.
 */
export class ToolMenu extends ToolMenuBase<ToolMenuCellSpec, ToolMenuCell> {
  private readonly bench: string;
  private readonly quickFindPrefix: string;

  constructor(navbar: Navbar, options: ToolMenuOptions) {
    super(navbar, options);
    this.bench = options.bench;
    this.quickFindPrefix = options.quickFindPrefix;
    this.layout();
  }

  protected createCell(spec: ToolMenuCellSpec, events: ToolMenuCellEvents<ToolMenuCell>): ToolMenuCell {
    return new ToolMenuCell(spec, spec.id, events);
  }

  protected quickFindEntry(cell: ToolMenuCell): QuickFindTool {
    const { spec } = cell;
    return {
      id: `${this.quickFindPrefix}:${spec.id}`,
      label: spec.label,
      tip: spec.description ?? spec.tip,
      bench: this.bench,
      iconSrc: spec.iconSrc,
      isAvailable: () => this.buttonShown,
      isDisabled: () => cell.disabled,
      isActive: () => cell.active,
      run: () => {
        this.close();
        cell.onClick?.();
      },
    };
  }

  protected layout(): void {
    // A stable sort: cells of one order (or none) keep the order they came in.
    const rank = (cell: ToolMenuCell) => cell.spec.order ?? Number.MAX_SAFE_INTEGER;
    this.cells.sort((a, b) => rank(a) - rank(b));
    if (this.cells.length === 0) {
      const text = document.createElement('p');
      text.dataset.ref = 'empty';
      text.className = 'w-48 p-1.5 text-xs text-base-content/75 leading-snug';
      text.textContent = this.emptyText;
      this.panel.replaceChildren(text);
    } else {
      this.panel.replaceChildren(this.grid(this.cells));
    }
    this.settle();
  }
}
