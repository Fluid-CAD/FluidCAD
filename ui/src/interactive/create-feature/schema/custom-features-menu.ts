import { ICON_CHEVRON_DOWN, ICON_CUSTOM_FEATURES } from '../../../ui/icons';
import type { Navbar } from '../../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../../ui/object-icons';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from '../../../ui/toolbar-styles';
import { viewportChrome } from '../../../ui/viewport-chrome';
import type { FeatureLauncher } from '../feature-button';
import type { SketchHideable } from '../finish-sketch-button';

/** How one feature shows in the menu. */
export type CustomFeatureCellSpec = {
  /** The feature's id — the cell's `data-tool="feature:<id>"`; null for an entry that has none (a module that failed to load). */
  id: string | null;
  label: string;
  iconSrc: string;
  /** The cell's tooltip: the full label (with the description), or why the entry can't be offered. */
  tip: string;
  /** Create-group features list first, then modify. */
  group: 'create' | 'modify';
  /** An entry the catalog can't offer: greyed, and its tooltip says why. */
  disabled?: boolean;
};

// The dropdown hangs off the button like the sketch toolbar's option menus
// (same surface, border and shadow), but from the page body: the bar clips
// its track sideways, and a grid near either end of it must stay whole.
const PANEL =
  'fixed z-[1200] p-1.5 overflow-y-auto max-w-[calc(100vw-16px)] '
  + 'panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
/** Three columns that narrow (labels truncating) only when the window can't fit them. */
const GRID = 'grid grid-cols-[repeat(3,minmax(0,5.5rem))] gap-1';
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
 * One feature in the menu's grid: its icon over its label, the click that
 * opens its dialog, and the armed styling while that dialog is open. The
 * dialog drives it as it would its own toolbar button.
 */
export class CustomFeatureCell implements FeatureLauncher {
  onClick?: () => void;

  /** The grid cell — it carries the tooltip, so a greyed entry still explains itself. */
  readonly el: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private _active = false;

  constructor(
    readonly spec: CustomFeatureCellSpec,
    private readonly events: {
      press: (cell: CustomFeatureCell) => void;
      activeChange: () => void;
      remove: (cell: CustomFeatureCell) => void;
    },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'relative min-w-0 flex';
    this.el.title = spec.tip;
    if (spec.id !== null) {
      this.el.dataset.tool = `feature:${spec.id}`;
    }
    this.button = document.createElement('button');
    this.button.setAttribute('aria-label', spec.tip);
    this.button.disabled = this.disabled;
    this.button.innerHTML = `<img src="${spec.iconSrc}" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`;
    const label = document.createElement('span');
    label.className = CELL_LABEL;
    label.textContent = spec.label;
    this.button.appendChild(label);
    this.button.addEventListener('click', () => this.events.press(this));
    this.el.appendChild(this.button);
    this.syncClass();
  }

  get active(): boolean {
    return this._active;
  }

  get disabled(): boolean {
    return this.spec.disabled === true;
  }

  setActive(active: boolean): void {
    if (this._active === active) {
      return;
    }
    this._active = active;
    this.syncClass();
    this.events.activeChange();
  }

  /** Take the cell out of the menu for good (its feature changed or left the catalog). */
  remove(): void {
    this.events.remove(this);
  }

  private syncClass(): void {
    // A greyed cell lets the hover through to the cell, whose tooltip says why.
    this.button.className = `${this._active ? CELL_ACTIVE : CELL_BASE}${this.disabled ? ' pointer-events-none' : ''}`;
  }
}

/**
 * The workspace's own features (its `*.feature.js` builders) under one
 * toolbar button: "Custom", the last group on the part bar (the page builds
 * it after every tool group), opening a dropdown with a three-column grid
 * of the features —
 * create-group ones first, then modify, each by label. A cell opens its
 * feature's dialog; an entry the catalog can't offer sits greyed with its
 * reason as the tooltip. The engine's built-ins that describe themselves
 * the same way (Draft) keep their regular buttons.
 *
 * The button shows only while there is a feature to list, leaves the bar
 * with the create buttons while a sketch is up (Finish Sketch hands it
 * {@link setSketchHidden}), and reads as armed while one of its features'
 * dialogs is open. The dropdown closes on a cell's click, Escape, a press
 * or a wheel anywhere else, and whenever a dialog opens; cells come and go
 * with the catalog under an open dropdown.
 */
export class CustomFeaturesMenu implements SketchHideable {
  /** The navbar group the button sits in. */
  static readonly GROUP = 'custom';

  private readonly wrap: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly cells: CustomFeatureCell[] = [];
  private sketchHidden = false;
  private opened = false;
  /** The dialogs open when the dropdown opened — one more closes it. */
  private dialogsAtOpen: ReadonlySet<string> = new Set();

  constructor(private readonly navbar: Navbar) {
    const group = navbar.getGroup(CustomFeaturesMenu.GROUP)
      ?? navbar.addGroup(CustomFeaturesMenu.GROUP, { visible: false });

    this.button = document.createElement('button');
    this.button.className = TOOLBAR_BTN_BASE;
    this.button.setAttribute('aria-label', 'Custom features');
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.innerHTML =
      `<span class="w-7 h-7 shrink-0 flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">${ICON_CUSTOM_FEATURES}</span>`
      + `<span class="${TOOLBAR_BTN_LABEL} flex items-center gap-0.5">Custom`
      + `<span class="[&>svg]:size-2.5" aria-hidden="true">${ICON_CHEVRON_DOWN}</span></span>`;
    this.button.addEventListener('click', () => this.toggle());
    this.wrap = document.createElement('span');
    this.wrap.className = 'tooltip tooltip-bottom shrink-0';
    this.wrap.dataset.tip = 'Custom features';
    this.wrap.dataset.tool = 'custom-features';
    this.wrap.appendChild(this.button);
    group.appendChild(this.wrap);

    this.panel = document.createElement('div');
    this.panel.className = PANEL;
    this.panel.dataset.role = 'custom-features-menu';
    // A click on a cell must not pull focus off the editor or the viewport.
    this.panel.addEventListener('mousedown', (e) => e.preventDefault());
    this.grid = document.createElement('div');
    this.grid.className = GRID;
    this.panel.appendChild(this.grid);

    viewportChrome.subscribeDialogs((openIds) => {
      if ([...openIds].some(id => !this.dialogsAtOpen.has(id))) {
        this.close();
      }
    });
  }

  /** List a feature; the cell stays until its {@link CustomFeatureCell.remove}. */
  add(spec: CustomFeatureCellSpec): CustomFeatureCell {
    const cell = new CustomFeatureCell(spec, {
      press: (pressed) => {
        this.close();
        pressed.onClick?.();
      },
      activeChange: () => this.syncActive(),
      remove: (removed) => this.drop(removed),
    });
    this.cells.push(cell);
    this.layout();
    return cell;
  }

  /** The cells in grid order. */
  get entries(): readonly CustomFeatureCell[] {
    return [...this.cells];
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Whether the button is on the bar: a feature to list, and no sketch up. */
  get isVisible(): boolean {
    return this.cells.length > 0 && !this.sketchHidden;
  }

  /** Armed: one of its features' dialogs is open. */
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

  private drop(cell: CustomFeatureCell): void {
    const index = this.cells.indexOf(cell);
    if (index < 0) {
      return;
    }
    this.cells.splice(index, 1);
    cell.el.remove();
    this.layout();
  }

  /** Order the grid, then bring the button and an open dropdown in line with it. */
  private layout(): void {
    this.cells.sort(CustomFeaturesMenu.compare);
    this.grid.replaceChildren(...this.cells.map(cell => cell.el));
    this.syncActive();
    this.syncVisible();
    if (this.isOpen) {
      this.position();
    }
  }

  /** Create-group features first, then modify, each by label. */
  private static compare(a: CustomFeatureCell, b: CustomFeatureCell): number {
    const rank = (cell: CustomFeatureCell) => (cell.spec.group === 'modify' ? 1 : 0);
    return rank(a) - rank(b)
      || a.spec.label.localeCompare(b.spec.label)
      || (a.spec.id ?? '').localeCompare(b.spec.id ?? '');
  }

  private syncActive(): void {
    this.button.className = this.isActive ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
  }

  private syncVisible(): void {
    // One vote, so a sketch hides the group whole — no empty group behind a divider.
    this.navbar.setGroupVisible(CustomFeaturesMenu.GROUP, this.isVisible);
    if (!this.isVisible) {
      this.close();
    }
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
