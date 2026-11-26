import type { PackageRef } from '../../../api';
import { ICON_PIN, ICON_PINNED_OFF } from '../../../ui/icons';
import { HubIcons } from '../../../ui/hub/hub-icons';
import type { Navbar } from '../../../ui/navbar';
import type { NavbarMode } from '../../../ui/navbar/navbar';
import { showPopupMenu } from '../../../ui/popup-menu';
import { isShownOnBar, type QuickFindTool } from '../../../ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_LABEL } from '../../../ui/toolbar-styles';
import { ToolMenuBase, ToolMenuCell, type ToolMenuCellEvents } from '../tool-menu';

/** How one feature shows in the menu. */
export type CustomFeatureCellSpec = {
  /** The feature's id — the cell's `data-tool="feature:<id>"`; null for an entry that has none (a module that failed to load). */
  id: string | null;
  /** The cell's `data-tool` in place of `feature:<id>` (a generated definition's `generated:<id>`). */
  tool?: string;
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

/** A group's heading, once a package's features share the menu with the workspace's. */
const GROUP_HEADING = 'flex items-center gap-1.5 px-1 pt-1.5 pb-1 text-[11px] text-base-content/55 min-w-0 first:pt-0.5';
const PIN_BUTTON = 'btn btn-ghost btn-xs btn-square size-5 min-h-0 ml-auto shrink-0 text-base-content/45 hover:text-base-content [&>svg]:size-3.5';
/** A cell pinned to the toolbar wears a toolbar button's look, in its tooltip wrapper. */
const PINNED_WRAP = 'tooltip tooltip-bottom shrink-0';

/**
 * One feature in the menu's grid: its icon over its label, the click that
 * opens its dialog, and the armed styling while that dialog is open. The
 * dialog drives it as it would its own toolbar button — and once its
 * package is pinned to the toolbar, it is one, on the bar.
 */
export class CustomFeatureCell extends ToolMenuCell<CustomFeatureCellSpec> {
  private _pinned = false;

  constructor(
    spec: CustomFeatureCellSpec,
    private readonly cellEvents: ToolMenuCellEvents<CustomFeatureCell> & {
      /** The cell's package changed (a library package got pinned): it may change group. */
      regroup: () => void;
    },
  ) {
    super(spec, spec.tool ?? (spec.id !== null ? `feature:${spec.id}` : undefined), cellEvents);
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
    this.cellEvents.regroup();
  }

  protected override syncClass(): void {
    if (!this._pinned) {
      super.syncClass();
      return;
    }
    // A greyed cell lets the hover through to the cell, whose tooltip says why.
    this.button.className = `${this.active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE}${this.disabled ? ' pointer-events-none' : ''}`;
    this.label.className = TOOLBAR_BTN_LABEL;
    this.el.className = PINNED_WRAP;
  }

  /** On the bar the tooltip is the toolbar's own; in the grid, the native one. */
  protected override syncTip(): void {
    if (!this._pinned) {
      delete this.el.dataset.tip;
      super.syncTip();
      return;
    }
    // A greyed entry's tip says why it can't be offered, so it wins.
    this.el.removeAttribute('title');
    this.el.dataset.tip = (!this.spec.disabled && this.spec.description) || this.spec.tip;
  }
}

/**
 * Where a {@link CustomFeaturesMenu} sits and what it says. Every field has
 * the part bar's Custom button as its default; the assembly bar's dropdown
 * of generated parts and assemblies gives its own.
 */
export type CustomFeaturesMenuOptions = {
  /** The navbar group the button sits in (default {@link CustomFeaturesMenu.GROUP}). */
  group?: string;
  /** The bench the button, the dropdown and the pinned groups show on (default `'part'`). */
  mode?: NavbarMode;
  /** The button's label on the toolbar (default "Custom"). */
  label?: string;
  /** The button's icon, a toolbar icon name for `iconUrl` (default `custom-features`). */
  icon?: string;
  /** The button's tooltip and aria label (default "Custom features"). */
  tip?: string;
  /** The button wrapper's `data-tool` (default `custom-features`). */
  tool?: string;
  /** The dropdown's `data-role` (default `custom-features-menu`). */
  role?: string;
  /** How a pinned package's toolbar group key starts: `<prefix><name>@<version>` (default `custom-package:`). */
  pinnedPrefix?: string;
  /** What the empty dropdown says, nothing listed (default: no custom features installed). */
  emptyText?: string;
  /** What it says with every entry pinned to the toolbar. */
  allPinnedText?: string;
};

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
 *
 * The same dropdown serves the assembly bar ({@link CustomFeaturesMenuOptions}):
 * a group of its own in `'assembly'` mode, listing generated parts and
 * assemblies — never shown in part mode, as the part bar's never shows in
 * assembly mode.
 */
export class CustomFeaturesMenu extends ToolMenuBase<CustomFeatureCellSpec, CustomFeatureCell> {
  /** The navbar group the part bar's button sits in. */
  static readonly GROUP = 'custom';

  /** The user pinned or unpinned a package: every pinned package's name, sorted. */
  onToolbarPackagesChange?: (names: string[]) => void;

  /** The packages pinned to the toolbar, by name. */
  private toolbarPackages = new Set<string>();
  /** The toolbar groups of the pinned packages listed now, by group key. */
  private readonly pinnedGroups = new Map<string, HTMLElement>();
  /** What the empty dropdown's button does (open the Hub panel); null hides the button with nothing to list. */
  private emptyAction: (() => void) | null = null;
  private readonly pinnedPrefix: string;
  private readonly allPinnedText: string;

  constructor(navbar: Navbar, options: CustomFeaturesMenuOptions = {}) {
    super(navbar, {
      group: options.group ?? CustomFeaturesMenu.GROUP,
      mode: options.mode ?? 'part',
      label: options.label ?? 'Custom',
      icon: options.icon ?? 'custom-features',
      tip: options.tip ?? 'Custom features',
      tool: options.tool ?? 'custom-features',
      role: options.role ?? 'custom-features-menu',
      emptyText: options.emptyText
        ?? 'No custom features installed. Check FluidCAD Hub for packages of features and parts.',
      columns: 3,
    });
    this.pinnedPrefix = options.pinnedPrefix ?? 'custom-package:';
    this.allPinnedText = options.allPinnedText
      ?? 'Every custom feature is pinned to the toolbar. Right-click a pinned group to unpin it.';
  }

  /** Whether the button is on the bar: a feature left to list (or the empty state's way to the hub), and no sketch up. */
  override get isVisible(): boolean {
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
  override get isActive(): boolean {
    return this.cells.some(cell => cell.active && !cell.pinned);
  }

  protected createCell(spec: CustomFeatureCellSpec, events: ToolMenuCellEvents<ToolMenuCell<CustomFeatureCellSpec>>): CustomFeatureCell {
    return new CustomFeatureCell(spec, { ...events, regroup: () => this.layout() });
  }

  /**
   * Quick Find finds the feature whether it sits in the dropdown (the
   * button on the bar) or, its package pinned, on the bar itself.
   */
  protected quickFindEntry(cell: CustomFeatureCell): QuickFindTool {
    const { spec } = cell;
    return {
      id: `custom:${spec.tool ?? spec.id ?? spec.label}`,
      label: spec.label,
      tip: spec.description ?? spec.tip,
      bench: this.mode === 'assembly' ? 'Generated' : 'Custom',
      iconSrc: spec.iconSrc,
      isAvailable: () => (cell.pinned ? isShownOnBar(cell.el) : this.buttonShown),
      isDisabled: () => cell.disabled,
      disabledReason: () => (cell.disabled ? spec.tip : null),
      isActive: () => cell.active,
      run: () => {
        this.close();
        cell.onClick?.();
      },
    };
  }

  /**
   * Order the grid, then bring the bar, the button and an open dropdown in
   * line with it. Each pinned package's features go to its toolbar group;
   * the rest stay in the dropdown. With a package's features there, each
   * source gets its own grid under a heading: the workspace's ("This
   * project") first, then each package by name, with its pin.
   */
  protected layout(): void {
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
        const grid = this.grid(group.cells);
        grid.dataset.group = group.pkg ? group.pkg.name : 'workspace';
        children.push(grid);
      }
      this.panel.replaceChildren(...children);
    }
    this.settle();
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
    const keyOf = (pkg: PackageRef) => `${this.pinnedPrefix}${pkg.name}@${pkg.version}`;
    const keep = new Set(groups.map(group => keyOf(group.pkg!)));
    for (const key of [...this.pinnedGroups.keys()]) {
      if (!keep.has(key)) {
        this.navbar.removeGroup(key);
        this.pinnedGroups.delete(key);
      }
    }
    let next = this.groupKey;
    for (const group of [...groups].reverse()) {
      const pkg = group.pkg!;
      const key = keyOf(pkg);
      let host = this.pinnedGroups.get(key);
      if (!host) {
        host = this.navbar.addGroup(key, { visible: false, before: next, mode: this.mode });
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
    text.textContent = allPinned ? this.allPinnedText : this.emptyText;
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

  /** The pinned groups leave the bar with the button while a sketch is up. */
  protected override syncVisible(): void {
    super.syncVisible();
    for (const key of this.pinnedGroups.keys()) {
      this.navbar.setGroupVisible(key, !this.sketchHidden);
    }
  }
}
