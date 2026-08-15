import { ICON_MENU, ICON_CHEVRON_DOWN, ICON_CHECK, ICON_CODE, ICON_LIST_TREE } from './icons';
import { FileTabs, type FileTab, type FileTabsHandlers } from '../editor/tabs';

const BTN_BASE = 'btn btn-ghost btn-sm text-base-content/60 gap-1 px-2';

export interface TopBarHandlers {
  /** Toggle the feature-tree (timeline) panel. */
  onToggleTree: () => void;
  /** Whether the feature-tree panel is currently visible, for the checkmark. */
  isTreeVisible: () => boolean;
  /**
   * Toggle the code-editor pane. Absent on a viewport-only host, which is
   * what removes the item from the menu.
   */
  onToggleEditor?: () => void;
  isEditorOpen?: () => boolean;
  /** Tab interactions. Absent on a viewport-only host — see {@link setFileName}. */
  tabs?: FileTabsHandlers;
}

/**
 * The top application bar (Onshape-inspired): logo + wordmark, a dropdown menu
 * for the panels, and the open files as tabs.
 *
 * The menu is deliberately short — panel toggles only. Anything that isn't a
 * panel belongs in the settings panel or, later, a native menu bar. And there
 * is no file tree here or anywhere: files are tabs, added with `+`
 * (`docs/desktop/05-editor-surface-design.md`).
 */
export class TopBar {
  private readonly el: HTMLDivElement;
  private readonly tabs: FileTabs;
  private readonly handlers: TopBarHandlers;
  private menu: HTMLDivElement | null = null;

  constructor(container: HTMLElement, handlers: TopBarHandlers) {
    this.handlers = handlers;
    this.el = document.createElement('div');
    this.el.className =
      'absolute top-0 left-0 right-0 h-12 z-[120] flex items-center gap-2 px-3 ' +
      'panel-bg border-b border-base-content/10 select-none';

    // Logo + wordmark
    const brand = document.createElement('div');
    brand.className = 'flex items-center gap-1.5 shrink-0';
    brand.innerHTML = `
      <img src="/logo.png" alt="FluidCAD" class="h-6 w-auto opacity-80" />
      <span class="text-[17px] font-bold text-base-content/80 tracking-tight">FluidCAD</span>
    `;
    this.el.appendChild(brand);

    const menuBtn = document.createElement('button');
    menuBtn.className = `${BTN_BASE} shrink-0`;
    menuBtn.title = 'Panels';
    menuBtn.innerHTML =
      `<span class="[&>svg]:size-5">${ICON_MENU}</span>` +
      `<span class="[&>svg]:size-3 opacity-70">${ICON_CHEVRON_DOWN}</span>`;
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu(menuBtn);
    });
    this.el.appendChild(menuBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
    this.el.appendChild(divider);

    this.tabs = new FileTabs(this.el, handlers.tabs ?? NO_TABS, handlers.tabs !== undefined);

    container.appendChild(this.el);
  }

  /** The plain label a viewport-only host shows instead of tabs. */
  setFileName(absPath: string): void {
    this.tabs.setFileName(absPath);
  }

  /** Where a menu-invoked quick-open should hang from. */
  get tabAddAnchor(): HTMLElement {
    return this.tabs.addAnchor;
  }

  setTabs(tabs: FileTab[], activePath: string | null, currentModelPath: string | null): void {
    this.tabs.setTabs(tabs, activePath, currentModelPath);
  }

  private toggleMenu(anchor: HTMLElement): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }

    const menu = document.createElement('div');
    // Two things this popover needs that the ones floating over the scene
    // don't, both because it drops over the Navbar's icon row:
    //
    // 1. It lives in `document.body`, not in the bar. The bar carries a
    //    `z-index` *and* a `backdrop-filter`, and either alone makes it a
    //    stacking context — so a child's `z-index` is capped by the bar's own
    //    and can never rise above the Navbar, which sits at the same z-120 and
    //    paints second.
    // 2. Its surface is opaque. `panel-bg` is 85% plus a blur, which reads
    //    fine over the scene but lets high-contrast toolbar buttons show
    //    straight through a menu.
    //
    // Border, radius and shadow still match every other popover.
    menu.className =
      'fixed z-[200] bg-base-100 border border-base-content/10 rounded-md ' +
      'shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;

    const list = document.createElement('ul');
    list.className = 'menu menu-xs p-1 min-w-[180px]';
    menu.appendChild(list);

    if (this.handlers.onToggleEditor) {
      list.appendChild(this.buildItem(
        ICON_CODE,
        'Code editor',
        this.handlers.isEditorOpen?.() === true,
        () => this.handlers.onToggleEditor?.(),
      ));
    }
    list.appendChild(this.buildItem(
      ICON_LIST_TREE,
      'Feature tree',
      this.handlers.isTreeVisible(),
      () => this.handlers.onToggleTree(),
    ));

    document.body.appendChild(menu);
    this.menu = menu;
    // Capture, so a click that lands on another overlay still closes the menu.
    setTimeout(() => document.addEventListener('pointerdown', this.onDocumentPointerDown, true));
  }

  private buildItem(icon: string, label: string, checked: boolean, onPick: () => void): HTMLLIElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'flex items-center gap-2';
    button.innerHTML =
      (checked
        ? `<span class="flex items-center justify-center w-4 h-4 shrink-0 text-primary [&>svg]:size-3">${ICON_CHECK}</span>`
        : '<span class="w-4 h-4 shrink-0"></span>') +
      `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${icon}</span>` +
      `<span></span>`;
    button.querySelector('span:last-child')!.textContent = label;
    button.addEventListener('click', () => {
      this.closeMenu();
      onPick();
    });
    item.appendChild(button);
    return item;
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.menu && !this.menu.contains(event.target as Node)) {
      this.closeMenu();
    }
  };

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
  }
}

/** Stand-in for a host with no tabs; never reached, since none are rendered. */
const NO_TABS: FileTabsHandlers = {
  onActivate: () => undefined,
  onClose: () => undefined,
  onAdd: () => undefined,
};
