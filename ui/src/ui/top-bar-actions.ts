import { onThemeChange } from '../scene/theme-colors';
import type { SceneObjectRender } from '../types';
import {
  ICON_CHEVRON_DOWN,
  ICON_DOWNLOAD,
  ICON_FILE_IMPORT,
  ICON_MENU,
  ICON_MOON,
  ICON_SUN,
} from './icons';

/** One exportable solid, as the Export list names it. */
export type ExportableSolid = { shapeId: string; name: string };

export interface TopBarExportHandlers {
  /** Open the export flow on the picked solid. */
  onExport(shapeId: string): void;
  /** A small transparent PNG of that solid alone — the row's thumbnail. */
  captureThumbnail(shapeId: string): Promise<Blob>;
}

/** A button a host adds to the bar of its own — see {@link TopBarActions.addAction}. */
export interface TopBarAction {
  /** Inline SVG markup — the bar shows the icon alone. */
  icon: string;
  /** Tooltip on the bar, and the accessible name. */
  title: string;
  /** The row's label in the collapsed menu, where there is room for words. Defaults to {@link title}. */
  label?: string;
  onClick(): void;
}

export interface TopBarActionHandlers {
  /** Persist the theme the toggle switched to. Absent: it still switches, nothing is stored. */
  saveTheme?(theme: string): void;
  /** The Export list. Absent: no Export control. */
  export?: TopBarExportHandlers;
  /** The Import button. Absent: none — a read-only host has nothing to import into. */
  onImport?(): void;
}

/**
 * Below this the buttons collapse into one menu. Same width the panel rail
 * stops docking at (`FLOAT_QUERY` in panel-rail.ts, `styles.css`): past it the
 * top bar has to fit the brand, the workspace and the tabs into what is left,
 * and three labelled buttons is more than it can spare.
 */
const COLLAPSE_QUERY = '(width < 40rem)';

// Icons alone on the bar: the words live in the tooltips, and in the menu
// rows the collapsed bar falls back to.
const ACTION_BTN = 'btn btn-ghost btn-sm btn-square text-base-content/70';
/** The Export disclosure — an icon plus its caret, so it cannot be square. */
const ACTION_BTN_CARET = 'btn btn-ghost btn-sm px-1.5 gap-0.5 text-base-content/70';
const ACTION_ICON = 'shrink-0 [&>svg]:size-4';

const PANEL =
  'absolute right-0 top-full mt-1 z-[200] min-w-[240px] max-h-[60vh] overflow-y-auto p-1 ' +
  'panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
const PANEL_ROW =
  'flex items-center gap-2.5 w-full px-2 py-1.5 rounded text-left text-[13px] ' +
  'text-base-content/80 cursor-pointer hover:bg-base-content/[0.08]';
const PANEL_EMPTY = 'px-3 py-2.5 text-[13px] text-base-content/50';
const ROW_THUMB =
  'w-11 h-11 shrink-0 flex items-center justify-center overflow-hidden rounded ' +
  'border border-base-content/10 bg-base-content/[0.04] [&>img]:w-full [&>img]:h-full [&>img]:object-contain';
const ROW_ICON = 'shrink-0 opacity-70 [&>svg]:size-4';
const ROW_CARET = 'shrink-0 opacity-60 [&>svg]:size-3 transition-transform';

const DARK_THEME = 'fluidcad-dark';
const LIGHT_THEME = 'fluidcad-light';

/**
 * The top bar's right-hand controls: the host's own buttons, then Import,
 * Export and the light/dark toggle.
 *
 * Import and Export are opt-in — a read-only host passes no `onImport` and
 * gets no button — while the theme toggle is always mounted: it is the app's
 * only theme control (it used to hang off the viewport settings dial, buried
 * under the gizmo) and every host that mounts a top bar wants it.
 *
 * Export lists the scene's solids with a rendered thumbnail apiece rather than
 * exporting the whole scene blind, so picking the right one is a matter of
 * recognising it. On a window narrower than {@link COLLAPSE_QUERY} the buttons
 * give the tabs their width back and become rows of one menu, where that same
 * list opens in place under an Export row.
 */
export class TopBarActions {
  private readonly el: HTMLDivElement;
  /** The buttons themselves — swapped out for {@link menuBtn} on a narrow window. */
  private readonly inline: HTMLSpanElement;
  private readonly slot: HTMLSpanElement;
  private readonly menuBtn: HTMLButtonElement;
  private readonly themeBtn: HTMLButtonElement;
  private readonly exportBtn: HTMLButtonElement | null = null;
  private readonly collapseQuery: MediaQueryList | null;
  /** What the host added through {@link addAction}, so the menu can list it too. */
  private readonly hostActions: TopBarAction[] = [];
  private solids: ExportableSolid[] = [];
  /** shapeId → object URL, for the current scene only. */
  private thumbs = new Map<string, string>();
  private panel: HTMLDivElement | null = null;
  private panelCleanup: (() => void) | null = null;

  constructor(container: HTMLElement, private readonly handlers: TopBarActionHandlers) {
    // `self-stretch` against the bar's `items-center` so a panel's `top-full`
    // lands on the bar's bottom edge, not the button's.
    this.el = document.createElement('div');
    this.el.className = 'relative ml-auto flex items-center gap-1 self-stretch shrink-0';

    this.inline = document.createElement('span');
    this.inline.className = 'flex items-center gap-1';
    this.el.appendChild(this.inline);

    this.slot = document.createElement('span');
    this.slot.className = 'flex items-center gap-1';
    this.inline.appendChild(this.slot);

    if (handlers.onImport) {
      const importBtn = this.addButton(this.inline, ICON_FILE_IMPORT, 'Import a STEP file');
      importBtn.addEventListener('click', () => {
        this.closePanel();
        handlers.onImport?.();
      });
    }

    if (handlers.export) {
      this.exportBtn = this.addButton(this.inline, ICON_DOWNLOAD, 'Export a solid', true);
      this.exportBtn.addEventListener('click', () => this.togglePanel('export'));
    }

    if (handlers.onImport || handlers.export) {
      const divider = document.createElement('div');
      divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
      this.inline.appendChild(divider);
    }

    this.themeBtn = this.addButton(this.inline, ICON_SUN, '');
    this.themeBtn.addEventListener('click', () => {
      this.closePanel();
      this.toggleTheme();
    });
    // Driven by the theme observer, not by the click: a host that applies a
    // stored theme after the bar is built lands on the right icon too.
    onThemeChange(() => this.syncThemeButton());
    this.syncThemeButton();

    this.menuBtn = this.addButton(this.el, ICON_MENU, 'Actions');
    this.menuBtn.addEventListener('click', () => this.togglePanel('menu'));

    this.collapseQuery = window.matchMedia?.(COLLAPSE_QUERY) ?? null;
    this.collapseQuery?.addEventListener('change', () => this.applyMode());
    this.applyMode();

    container.appendChild(this.el);
  }

  /** Add a host's own button, ahead of Import/Export/theme and styled like them. */
  addAction(action: TopBarAction): HTMLButtonElement {
    this.hostActions.push(action);
    const button = this.addButton(this.slot, action.icon, action.title);
    button.addEventListener('click', () => {
      this.closePanel();
      action.onClick();
    });
    return button;
  }

  /** New scene: refresh the Export list and drop thumbnails of what is gone. */
  updateSolids(objects: SceneObjectRender[]): void {
    if (!this.handlers.export) {
      return;
    }
    const solids = TopBarActions.collectSolids(objects);
    // Re-renders with the same solids (a parameter tweak, a preference) keep
    // the open list and its cached thumbnails.
    const unchanged =
      solids.length === this.solids.length &&
      solids.every((s, i) => s.shapeId === this.solids[i].shapeId && s.name === this.solids[i].name);
    this.solids = solids;
    if (unchanged) {
      return;
    }
    for (const url of this.thumbs.values()) {
      URL.revokeObjectURL(url);
    }
    this.thumbs.clear();
    this.closePanel();
  }

  /** Whether the window is narrow enough that the buttons collapse into a menu. */
  private get collapsed(): boolean {
    return this.collapseQuery?.matches === true;
  }

  private applyMode(): void {
    this.inline.classList.toggle('hidden', this.collapsed);
    this.menuBtn.classList.toggle('hidden', !this.collapsed);
    // The open panel hangs off whichever control just went away.
    this.closePanel();
  }

  private addButton(parent: HTMLElement, icon: string, tooltip: string, caret = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = caret ? ACTION_BTN_CARET : ACTION_BTN;
    button.title = tooltip;
    button.setAttribute('aria-label', tooltip);
    const iconEl = document.createElement('span');
    iconEl.className = ACTION_ICON;
    iconEl.innerHTML = icon;
    button.appendChild(iconEl);
    if (caret) {
      const caretEl = document.createElement('span');
      caretEl.className = ROW_CARET;
      caretEl.innerHTML = ICON_CHEVRON_DOWN;
      button.appendChild(caretEl);
    }
    parent.appendChild(button);
    return button;
  }

  // -------------------------------------------------------------------------
  // The dropdown panel — the Export list on a wide window, the whole action
  // menu on a narrow one. Only ever one is open, so they share the mounting
  // and the dismiss listeners.
  // -------------------------------------------------------------------------

  private togglePanel(kind: 'menu' | 'export'): void {
    if (this.panel?.dataset.panel === kind) {
      this.closePanel();
      return;
    }
    this.closePanel();
    const panel = kind === 'menu' ? this.buildMenu() : this.buildSolidList();
    panel.dataset.panel = kind;
    this.el.appendChild(panel);
    this.panel = panel;
    this.fillThumbs(panel);

    const onPointerDown = (e: PointerEvent) => {
      if (!this.el.contains(e.target as Node)) {
        this.closePanel();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closePanel();
      }
    };
    // Registered after the opening event's cycle so they can't race the click
    // that opened the panel.
    let listening = false;
    setTimeout(() => {
      if (this.panel === panel) {
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        listening = true;
      }
    }, 0);
    this.panelCleanup = () => {
      if (listening) {
        document.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
      }
    };
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.panelCleanup?.();
    this.panelCleanup = null;
  }

  /** The collapsed window's menu: every button on the bar, one row apiece. */
  private buildMenu(): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = PANEL;

    for (const action of this.hostActions) {
      menu.appendChild(this.buildRow(action.icon, action.label ?? action.title, () => {
        this.closePanel();
        action.onClick();
      }));
    }

    if (this.handlers.onImport) {
      menu.appendChild(this.buildRow(ICON_FILE_IMPORT, 'Import', () => {
        this.closePanel();
        this.handlers.onImport?.();
      }));
    }

    if (this.handlers.export) {
      // A disclosure rather than a submenu: the thumbnails are WebGL renders,
      // so they are only worth taking when someone asks to export.
      const caret = document.createElement('span');
      caret.className = ROW_CARET;
      caret.innerHTML = ICON_CHEVRON_DOWN;
      const row = this.buildRow(ICON_DOWNLOAD, 'Export', () => {
        const open = this.toggleExportSection(menu, row);
        caret.classList.toggle('rotate-180', open);
      });
      row.appendChild(caret);
      menu.appendChild(row);
    }

    menu.appendChild(this.buildRow(this.themeIcon(), this.themeLabel(), () => {
      this.closePanel();
      this.toggleTheme();
    }));
    return menu;
  }

  /** Expand or collapse the menu's solid list. Returns whether it is now open. */
  private toggleExportSection(menu: HTMLElement, row: HTMLElement): boolean {
    const open = menu.querySelector('[data-export-section]');
    if (open) {
      open.remove();
      return false;
    }
    const section = document.createElement('div');
    section.dataset.exportSection = '';
    section.className = 'pl-4';
    if (this.solids.length === 0) {
      section.appendChild(this.buildEmpty());
    } else {
      for (const solid of this.solids) {
        section.appendChild(this.buildSolidRow(solid));
      }
    }
    row.after(section);
    this.fillThumbs(menu);
    return true;
  }

  /** The Export button's own panel — the solid list on its own. */
  private buildSolidList(): HTMLDivElement {
    const list = document.createElement('div');
    list.className = PANEL;
    if (this.solids.length === 0) {
      list.appendChild(this.buildEmpty());
      return list;
    }
    for (const solid of this.solids) {
      list.appendChild(this.buildSolidRow(solid));
    }
    return list;
  }

  private buildEmpty(): HTMLDivElement {
    const empty = document.createElement('div');
    empty.className = PANEL_EMPTY;
    empty.textContent = 'No solids in the scene';
    return empty;
  }

  private buildRow(icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const row = document.createElement('button');
    row.className = PANEL_ROW;
    const iconEl = document.createElement('span');
    iconEl.className = ROW_ICON;
    iconEl.innerHTML = icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'flex-1 truncate';
    labelEl.textContent = label;
    row.append(iconEl, labelEl);
    row.addEventListener('click', onClick);
    return row;
  }

  private buildSolidRow(solid: ExportableSolid): HTMLButtonElement {
    const row = document.createElement('button');
    row.className = PANEL_ROW;

    const thumb = document.createElement('span');
    thumb.dataset.thumb = solid.shapeId;
    thumb.className = ROW_THUMB;
    thumb.innerHTML = '<span class="loading loading-spinner loading-xs opacity-40"></span>';

    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = solid.name;

    row.append(thumb, label);
    row.addEventListener('click', () => {
      this.closePanel();
      this.handlers.export?.onExport(solid.shapeId);
    });
    return row;
  }

  /**
   * Captures are synchronous WebGL renders (shaders compile on first use): let
   * the panel paint first, then fill its thumbnails one at a time.
   */
  private fillThumbs(panel: HTMLElement): void {
    const hosts = [...panel.querySelectorAll<HTMLElement>('[data-thumb]')];
    if (hosts.length === 0) {
      return;
    }
    setTimeout(async () => {
      for (const host of hosts) {
        if (this.panel !== panel || !host.isConnected) {
          return;
        }
        await this.loadThumb(host.dataset.thumb ?? '', host);
      }
    }, 0);
  }

  private async loadThumb(shapeId: string, host: HTMLElement): Promise<void> {
    try {
      let url = this.thumbs.get(shapeId);
      if (url === undefined) {
        const blob = await this.handlers.export!.captureThumbnail(shapeId);
        // A scene update may have raced the capture; don't cache stale pixels.
        if (!this.solids.some((s) => s.shapeId === shapeId)) {
          return;
        }
        url = URL.createObjectURL(blob);
        this.thumbs.set(shapeId, url);
      }
      if (host.isConnected) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        host.replaceChildren(img);
      }
    } catch {
      if (host.isConnected) {
        host.replaceChildren();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  private toggleTheme(): void {
    const next = TopBarActions.isDark() ? LIGHT_THEME : DARK_THEME;
    document.documentElement.setAttribute('data-theme', next);
    this.handlers.saveTheme?.(next);
  }

  /** The icon for what a click would switch TO, so it reads as the destination. */
  private themeIcon(): string {
    return TopBarActions.isDark() ? ICON_SUN : ICON_MOON;
  }

  private themeLabel(): string {
    return TopBarActions.isDark() ? 'Switch to light theme' : 'Switch to dark theme';
  }

  private syncThemeButton(): void {
    const icon = this.themeBtn.firstElementChild as HTMLElement;
    icon.innerHTML = this.themeIcon();
    this.themeBtn.title = this.themeLabel();
    this.themeBtn.setAttribute('aria-label', this.themeLabel());
  }

  private static isDark(): boolean {
    return (document.documentElement.getAttribute('data-theme') || DARK_THEME) !== LIGHT_THEME;
  }

  /**
   * The scene's exportable solids, named like the Shapes panel names them:
   * the owning object's name, numbered when one object contributes several.
   */
  private static collectSolids(objects: SceneObjectRender[]): ExportableSolid[] {
    const solids: ExportableSolid[] = [];
    const seen = new Set<string>();
    for (const object of objects) {
      for (const part of object.sceneShapes ?? []) {
        if (part.shapeType !== 'solid' || part.isMetaShape || part.isGuide) {
          continue;
        }
        if (part.shapeId === undefined || seen.has(part.shapeId)) {
          continue;
        }
        seen.add(part.shapeId);
        solids.push({ shapeId: part.shapeId, name: object.name || 'Solid' });
      }
    }
    const totals = new Map<string, number>();
    for (const solid of solids) {
      totals.set(solid.name, (totals.get(solid.name) ?? 0) + 1);
    }
    const counts = new Map<string, number>();
    for (const solid of solids) {
      if ((totals.get(solid.name) ?? 0) > 1) {
        const n = (counts.get(solid.name) ?? 0) + 1;
        counts.set(solid.name, n);
        solid.name = `${solid.name} ${n}`;
      }
    }
    return solids;
  }
}
