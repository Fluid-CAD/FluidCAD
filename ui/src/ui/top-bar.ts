import { FileTabs, type FileTab, type FileTabsHandlers } from '../editor/tabs';

export interface TopBarHandlers {
  /** Tab interactions. Absent on a viewport-only host — see {@link TopBar.setFileName}. */
  tabs?: FileTabsHandlers;
}

/**
 * The top application bar (Onshape-inspired): logo + wordmark, the workspace
 * name, and the open files as tabs.
 *
 * It carries no controls of its own. Panel toggles used to hide behind a
 * hamburger here; they are latch buttons on the PanelRail now, beside
 * the panels they open. And there is no file tree here or anywhere: files are
 * tabs, added with `+` (`docs/desktop/05-editor-surface-design.md`).
 */
export class TopBar {
  private readonly el: HTMLDivElement;
  private readonly tabs: FileTabs;
  private readonly workspaceName: HTMLSpanElement;

  constructor(container: HTMLElement, handlers: TopBarHandlers) {
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

    // Divider — the brand on one side, the open document on the other.
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
    this.el.appendChild(divider);

    // Workspace folder name, ahead of the tabs — the document the tabs are
    // pages of. Hidden until a host that knows its workspace names it.
    this.workspaceName = document.createElement('span');
    this.workspaceName.className =
      'hidden text-[17px] font-semibold text-base-content/80 tracking-tight truncate max-w-[20vw] shrink-0 mr-1';
    this.el.appendChild(this.workspaceName);

    this.tabs = new FileTabs(this.el, handlers.tabs ?? NO_TABS, handlers.tabs !== undefined);

    container.appendChild(this.el);
  }

  /** The plain label a viewport-only host shows instead of tabs. */
  setFileName(absPath: string): void {
    this.tabs.setFileName(absPath);
  }

  /** The workspace's folder name, shown ahead of the tabs. */
  setWorkspaceName(name: string): void {
    this.workspaceName.textContent = name;
    this.workspaceName.classList.toggle('hidden', name === '');
  }

  /** Where a menu-invoked quick-open should hang from. */
  get tabAddAnchor(): HTMLElement {
    return this.tabs.addAnchor;
  }

  setTabs(tabs: FileTab[], activePath: string | null, currentModelPath: string | null): void {
    this.tabs.setTabs(tabs, activePath, currentModelPath);
  }
}

/** Stand-in for a host with no tabs; never reached, since none are rendered. */
const NO_TABS: FileTabsHandlers = {
  onActivate: () => undefined,
};
