import type { PackageRef } from '../../../api';
import { ICON_CHEVRON_DOWN, ICON_PIN, ICON_PINNED_OFF } from '../../../ui/icons';
import { HubIcons } from '../../../ui/hub/hub-icons';
import { iconUrl } from '../../../ui/icon-url';
import type { Navbar } from '../../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../../ui/object-icons';
import { showPopupMenu } from '../../../ui/popup-menu';
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
  /** The cell's aria label: the full label (with the description), or why the entry can't be offered. */
  tip: string;
  /** The feature's description — its tooltip, as a built-in tool's says what it does; absent, the tooltip is {@link tip}. */
  description?: string;
  /** Create-group features list first, then modify. */
  group: 'create' | 'modify';
  /** An entry the catalog can't offer: greyed, and its tooltip says why. */
  disabled?: boolean;
  /**
   * The installed package the feature comes from; absent for the
   * workspace's own. The menu groups by it, and a package pinned to the
   * toolbar takes its group there.
   */
  package?: PackageRef;
};

// The dropdown hangs off the button like the sketch toolbar's option menus
// (same surface, border and shadow), but from the page body: the bar clips
// its track sideways, and a grid near either end of it must stay whole.
const PANEL =
  'fixed z-[1200] p-1.5 overflow-y-auto max-w-[calc(100vw-16px)] '
  + 'panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
/** Three columns that narrow (labels truncating) only when the window can't fit them. */
const GRID = 'grid grid-cols-[repeat(3,minmax(0,5.5rem))] gap-1';
/** A group's heading, once a package's features share the menu with the workspace's. */
const GROUP_HEADING = 'flex items-center gap-1.5 px-1 pt-1.5 pb-1 text-[11px] text-base-content/55 min-w-0 first:pt-0.5';
const PIN_BUTTON = 'btn btn-ghost btn-xs btn-square size-5 min-h-0 ml-auto shrink-0 text-base-content/45 hover:text-base-content [&>svg]:size-3.5';
// The toolbar's own idle and armed looks, stretched to the cell.
const CELL_SHAPE = 'btn btn-sm h-auto w-full min-w-0 flex-col gap-1 px-1 py-2';
const CELL_BASE = `${CELL_SHAPE} btn-ghost text-base-content/70`;
const CELL_ACTIVE = `${CELL_SHAPE} btn-soft btn-primary`;
const CELL_LABEL = 'block max-w-full truncate text-[11px] leading-tight';
/** A cell pinned to the toolbar wears a toolbar button's look, in its tooltip wrapper. */
const PINNED_WRAP = 'tooltip tooltip-bottom shrink-0';
/** A pinned package's toolbar group key: `custom-package:<name>@<version>`. */
const PINNED_GROUP_PREFIX = 'custom-package:';

/** Clearance from the window's edges, in pixels. */
const EDGE = 8;
/** Gap between the button and the dropdown, in pixels. */
const GAP = 6;

/**
 * One feature in the menu's grid: its icon over its label, the click that
 * opens its dialog, and the armed styling while that dialog is open. The
 * dialog drives it as it would its own toolbar button — and once its
 * package is pinned to the toolbar, it is one, on the bar.
 */
export class CustomFeatureCell implements FeatureLauncher {
  onClick?: () => void;

  /** The grid cell — it carries the tooltip, so a greyed entry still explains itself. */
  readonly el: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private _active = false;
  private _pinned = false;

  constructor(
    readonly spec: CustomFeatureCellSpec,
    private readonly events: {
      press: (cell: CustomFeatureCell) => void;
      activeChange: () => void;
      remove: (cell: CustomFeatureCell) => void;
      /** The cell's package changed (a library package got pinned): it may change group. */
      regroup: () => void;
    },
  ) {
    this.el = document.createElement('div');
    if (spec.id !== null) {
      this.el.dataset.tool = `feature:${spec.id}`;
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
    return this.spec.disabled === true;
  }

  /** On the toolbar, its package pinned there, rather than in the dropdown's grid. */
  get pinned(): boolean {
    return this._pinned;
  }

  /** Wear the toolbar button's look (its package pinned to the bar) or the grid cell's. */
  setPinned(pinned: boolean): void {
    if (this._pinned === pinned) {
      return;
    }
    this._pinned = pinned;
    this.syncClass();
    this.syncTip();
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

  /**
   * The package the feature comes from changed while its dialog stayed (the
   * project just pinned a library package by using it): the cell moves to
   * that package's group.
   */
  setPackage(pkg: PackageRef | undefined): void {
    const before = JSON.stringify(this.spec.package ?? null);
    if (before === JSON.stringify(pkg ?? null)) {
      return;
    }
    (this.spec as { package?: PackageRef }).package = pkg;
    this.events.regroup();
  }

  private syncClass(): void {
    const look = this._pinned
      ? (this._active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE)
      : (this._active ? CELL_ACTIVE : CELL_BASE);
    // A greyed cell lets the hover through to the cell, whose tooltip says why.
    this.button.className = `${look}${this.disabled ? ' pointer-events-none' : ''}`;
    this.label.className = this._pinned ? TOOLBAR_BTN_LABEL : CELL_LABEL;
    this.el.className = this._pinned ? PINNED_WRAP : 'relative min-w-0 flex';
  }

  /** On the bar the tooltip is the toolbar's own; in the grid, the native one. */
  private syncTip(): void {
    // A greyed entry's tip says why it can't be offered, so it wins.
    const tip = (!this.disabled && this.spec.description) || this.spec.tip;
    if (this._pinned) {
      this.el.removeAttribute('title');
      this.el.dataset.tip = tip;
    } else {
      delete this.el.dataset.tip;
      this.el.title = tip;
    }
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
 * The button shows while there is a feature to list, or, once the page
 * gives it somewhere to send the user ({@link setEmptyAction}: the Hub
 * panel, H11), with none: the dropdown then says no custom features are
 * installed and opens the Hub panel. It leaves the bar with the create
 * buttons while a sketch is up (Finish Sketch hands it
 * {@link setSketchHidden}), and reads as armed while one of its features'
 * dialogs is open. The dropdown closes on a cell's click, Escape, a press
 * or a wheel anywhere else, and whenever a dialog opens; cells come and go
 * with the catalog under an open dropdown.
 *
 * A package's heading in the dropdown carries a pin: pinned, the package's
 * features leave the dropdown for the toolbar, as buttons in a group of
 * their own (between dividers) ahead of the Custom button, packages by
 * name. A right-click on that group unpins it. The pins are the user's
 * (a preference, by package name), so they follow the package into every
 * project that offers it: the page hands them in ({@link setToolbarPackages})
 * and hears every change ({@link onToolbarPackagesChange}).
 */
export class CustomFeaturesMenu implements SketchHideable {
  /** The navbar group the button sits in. */
  static readonly GROUP = 'custom';

  /** The user pinned or unpinned a package: every pinned package's name, sorted. */
  onToolbarPackagesChange?: (names: string[]) => void;

  private readonly wrap: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly cells: CustomFeatureCell[] = [];
  private sketchHidden = false;
  private opened = false;
  /** The packages pinned to the toolbar, by name. */
  private toolbarPackages = new Set<string>();
  /** The toolbar groups of the pinned packages listed now, by group key. */
  private readonly pinnedGroups = new Map<string, HTMLElement>();
  /** What the empty dropdown's button does (open the Hub panel); null hides the button with nothing to list. */
  private emptyAction: (() => void) | null = null;
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
      `<img src="${iconUrl('custom-features')}" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
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
      regroup: () => this.layout(),
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

  /** Whether the button is on the bar: a feature left to list (or the empty state's way to the hub), and no sketch up. */
  get isVisible(): boolean {
    return (this.cells.some(cell => !cell.pinned) || this.emptyAction !== null) && !this.sketchHidden;
  }

  /** The packages pinned to the toolbar, by name, sorted. */
  get pinnedPackages(): string[] {
    return [...this.toolbarPackages].sort();
  }

  /** The pins as stored (the preferences loaded, or reset): no {@link onToolbarPackagesChange}. */
  setToolbarPackages(names: Iterable<string>): void {
    this.toolbarPackages = new Set(names);
    this.layout();
  }

  /** Put a package's features on the toolbar, ahead of the Custom button. */
  pin(name: string): void {
    if (this.toolbarPackages.has(name)) {
      return;
    }
    this.toolbarPackages.add(name);
    this.layout();
    this.onToolbarPackagesChange?.(this.pinnedPackages);
  }

  /** Take a package's features off the toolbar, back into the dropdown. */
  unpin(name: string): void {
    if (!this.toolbarPackages.delete(name)) {
      return;
    }
    this.layout();
    this.onToolbarPackagesChange?.(this.pinnedPackages);
  }

  /**
   * Keep the button with no custom features, its dropdown saying so with a
   * button that runs `action` (the page opens the Hub panel); null goes back
   * to hiding it.
   */
  setEmptyAction(action: (() => void) | null): void {
    this.emptyAction = action;
    this.layout();
  }

  /** Armed: one of its listed features' dialogs is open (a pinned one arms its own button). */
  get isActive(): boolean {
    return this.cells.some(cell => cell.active && !cell.pinned);
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

  /** Off the bar while a sketch is up, like the create buttons — and the dropdown and the pinned groups with it. */
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

  /**
   * Order the grid, then bring the bar, the button and an open dropdown in
   * line with it. Each pinned package's features go to its toolbar group;
   * the rest stay in the dropdown. With a package's features there, each
   * source gets its own grid under a heading: the workspace's ("This
   * project") first, then each package by name, with its pin.
   */
  private layout(): void {
    this.cells.sort(CustomFeaturesMenu.compare);
    const groups = CustomFeaturesMenu.groupsOf(this.cells);
    const pinned = groups.filter(group => this.isPinned(group.pkg));
    const listed = groups.filter(group => !this.isPinned(group.pkg));
    for (const group of groups) {
      for (const cell of group.cells) {
        cell.setPinned(this.isPinned(group.pkg));
      }
    }
    this.layoutBar(pinned);
    if (listed.length === 0 && this.emptyAction) {
      this.panel.replaceChildren(this.emptyState(this.cells.length > 0));
    } else {
      const headed = listed.some(group => group.pkg !== null);
      const children: HTMLElement[] = [];
      for (const group of listed) {
        if (headed) {
          children.push(this.heading(group.pkg));
        }
        const grid = document.createElement('div');
        grid.className = GRID;
        grid.dataset.group = group.pkg ? group.pkg.name : 'workspace';
        grid.replaceChildren(...group.cells.map(cell => cell.el));
        children.push(grid);
      }
      this.panel.replaceChildren(...children);
    }
    this.syncActive();
    this.syncVisible();
    if (this.isOpen) {
      this.position();
    }
  }

  private isPinned(pkg: PackageRef | null): pkg is PackageRef {
    return pkg !== null && this.toolbarPackages.has(pkg.name);
  }

  /**
   * One toolbar group per pinned package, in menu order, right before the
   * Custom button's: groups of packages no longer listed (or unpinned)
   * leave the bar, new ones go in ahead of the next one kept.
   */
  private layoutBar(groups: readonly { pkg: PackageRef | null; cells: CustomFeatureCell[] }[]): void {
    const keyOf = (pkg: PackageRef) => `${PINNED_GROUP_PREFIX}${pkg.name}@${pkg.version}`;
    const keep = new Set(groups.map(group => keyOf(group.pkg!)));
    for (const key of [...this.pinnedGroups.keys()]) {
      if (!keep.has(key)) {
        this.navbar.removeGroup(key);
        this.pinnedGroups.delete(key);
      }
    }
    let next = CustomFeaturesMenu.GROUP;
    for (const group of [...groups].reverse()) {
      const pkg = group.pkg!;
      const key = keyOf(pkg);
      let host = this.pinnedGroups.get(key);
      if (!host) {
        host = this.navbar.addGroup(key, { visible: false, before: next });
        host.dataset.package = pkg.name;
        host.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.showUnpinMenu(host!, e, pkg.name);
        });
        this.pinnedGroups.set(key, host);
      }
      host.replaceChildren(...group.cells.map(cell => cell.el));
      next = key;
    }
  }

  /** A pinned group's right-click menu: unpin its package. */
  private showUnpinMenu(host: HTMLElement, e: MouseEvent, name: string): void {
    showPopupMenu(host.closest<HTMLElement>('#fluidcad-viewer') ?? document.body, e, [{
      icon: ICON_PINNED_OFF,
      label: 'Unpin',
      onSelect: () => this.unpin(name),
    }]);
  }

  /**
   * No custom features — or every one pinned to the toolbar (`allPinned`):
   * what that means, and the way to the Hub panel.
   */
  private emptyState(allPinned: boolean): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.ref = 'empty';
    box.className = 'w-64 p-1.5 flex flex-col gap-2.5';
    const text = document.createElement('p');
    text.className = 'text-xs text-base-content/75 leading-snug';
    text.textContent = allPinned
      ? 'Every custom feature is pinned to the toolbar. Right-click a pinned group to unpin it.'
      : 'No custom features installed. Check FluidCAD Hub for packages of features and parts.';
    const open = document.createElement('button');
    open.type = 'button';
    open.dataset.ref = 'open-hub';
    open.className = 'btn btn-sm btn-primary gap-1.5 self-start';
    open.append(HubIcons.span(HubIcons.PACKAGES, '[&>svg]:size-4'), 'Open FluidCAD Hub');
    open.addEventListener('click', () => {
      this.close();
      this.emptyAction?.();
    });
    box.append(text, open);
    return box;
  }

  /** The cells by source, in menu order: the workspace's, then each package by name and version. */
  private static groupsOf(cells: readonly CustomFeatureCell[]): { pkg: PackageRef | null; cells: CustomFeatureCell[] }[] {
    const groups = new Map<string, { pkg: PackageRef | null; cells: CustomFeatureCell[] }>();
    for (const cell of cells) {
      const pkg = cell.spec.package ?? null;
      const key = pkg ? `${pkg.name}@${pkg.version}` : '';
      if (!groups.has(key)) {
        groups.set(key, { pkg, cells: [] });
      }
      groups.get(key)!.cells.push(cell);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
      .map(([, group]) => group);
  }

  private heading(pkg: PackageRef | null): HTMLDivElement {
    const heading = document.createElement('div');
    heading.className = GROUP_HEADING;
    heading.dataset.groupHeading = pkg ? pkg.name : 'workspace';
    const name = document.createElement('span');
    name.className = 'truncate font-medium text-base-content/70';
    name.textContent = pkg ? pkg.name : 'This project';
    heading.appendChild(name);
    if (pkg) {
      const version = document.createElement('span');
      version.className = 'tabular-nums shrink-0';
      version.textContent = pkg.version;
      heading.appendChild(version);
    }
    if (pkg) {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.dataset.ref = 'pin';
      pin.className = PIN_BUTTON;
      pin.innerHTML = ICON_PIN;
      pin.title = 'Pin to the toolbar';
      pin.setAttribute('aria-label', `Pin ${pkg.name} to the toolbar`);
      pin.addEventListener('click', () => this.pin(pkg.name));
      heading.appendChild(pin);
    }
    return heading;
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
    for (const key of this.pinnedGroups.keys()) {
      this.navbar.setGroupVisible(key, !this.sketchHidden);
    }
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
