import type { HubClient, HubStatus, PackagesClient, PackageTarget } from '../../api';
import { HubAccount } from './hub-account';
import { HubIcons } from './hub-icons';
import { HubInstallTarget, type HubInstalled, type HubTargetMemory } from './hub-install-control';
import { HubPackageView } from './hub-package-view';
import { HubPanelState } from './hub-panel-state';
import type { HubEngine } from './hub-row';
import { HubSearchView } from './hub-search-view';

export type HubPanelDeps = {
  /** `#fluidcad-viewer`, the positioning context every overlay shares. */
  container: HTMLElement;
  hub: HubClient;
  packages: PackagesClient;
  /** Settings → Packages' "New packages go to": where the install target starts. */
  installSetting(): PackageTarget;
  /** Whether a project is open (pins, the project target). */
  projectOpen(): boolean;
  /** Where each project keeps its last install target (H12); absent, the choice lasts while the page is open. */
  targetMemory?: HubTargetMemory;
  /** Open a web page in the user's browser, through the host. */
  openExternal(url: string): void;
  /** A package was installed or upgraded: the catalogs, the scene and the Packages overview catch up. */
  onPackagesChanged(installed: HubInstalled): void;
  /** The slot's width when the panel opens (the code editor's, which it shares). */
  width(): number;
  /** The panel was dragged to `width`: the editor takes the same width next time. */
  onWidthChange?(width: number): void;
  /** Just before the panel takes the slot: whatever holds it (the code editor) closes. */
  onTakeSlot?(): void;
  onOpenChange?(open: boolean): void;
  /** Timers for the search debounce and for following a sign-in (tests). */
  timers?: ConstructorParameters<typeof HubPanelState>[1];
};

const WIDTH_VARIABLE = '--fluidcad-editor-width';
const MIN_WIDTH = 280;
const MIN_SCENE_WIDTH = 280;
const MOBILE_BREAKPOINT = 640;

/**
 * The Hub panel (hub-plan H11): search the hub, read a package, install it,
 * docked on the left from the rail's Hub button.
 *
 * **One slot with the code editor** (decision 5): it docks where the editor
 * pane does and takes width the same way (`--fluidcad-editor-width`, which
 * insets the scene), at the editor's width; opening it closes the editor
 * ({@link HubPanelDeps.onTakeSlot}) and opening the editor closes it
 * ({@link yieldSlot}, which leaves the width to the editor). On a narrow
 * window it covers the scene, as the editor does. Hosts without the
 * in-app editor (VS Code, Neovim) dock it the same way.
 *
 * The header says "FluidCAD Hub" (the address is in Settings → Packages)
 * and who is signed in, with Sign in when nobody is ({@link HubAccount}:
 * `fluidcad login`'s flow, run by the engine). Below it, the search
 * ({@link HubSearchView}) or a package ({@link HubPackageView}), whose
 * Results control comes back to the search where it was. Every publisher
 * handle (a result's `@scope`, a package's byline, the signed-in account)
 * lists that publisher's packages ({@link showPublisher}).
 */
export class HubPanel {
  readonly el: HTMLElement;
  readonly state: HubPanelState;
  private readonly offlineDot: HTMLSpanElement;
  private readonly account: HubAccount;
  private readonly search: HubSearchView;
  private readonly detail: HubPackageView;
  private readonly target: HubInstallTarget;
  private status: HubStatus | null = null;
  private open = false;
  private width: number;
  private view: 'search' | 'package' = 'search';
  private searchScroll = 0;
  private searchStale = false;

  constructor(private readonly deps: HubPanelDeps) {
    this.width = HubPanel.clampWidth(deps.width());
    this.state = new HubPanelState(deps.hub, deps.timers);
    this.target = new HubInstallTarget(() => deps.installSetting(), () => deps.projectOpen(), deps.targetMemory ?? null);
    void this.target.restore();

    this.el = document.createElement('aside');
    this.el.dataset.role = 'hub-panel';
    this.el.setAttribute('aria-label', 'FluidCAD Hub');
    this.el.className =
      'absolute left-[var(--fluidcad-rail-width,0px)] top-[var(--fluidcad-chrome-top,104px)] bottom-0 z-[115] '
      + 'flex flex-col bg-base-100 text-base-content border-r border-base-content/10 text-sm hidden';
    this.el.style.width = `${this.width}px`;

    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 h-11 shrink-0 pl-3 pr-1.5 border-b border-base-content/10';
    header.appendChild(HubIcons.span(HubIcons.PACKAGES, '[&>svg]:size-4 text-base-content/60'));
    const title = document.createElement('span');
    title.className = 'text-sm font-medium text-base-content/90 shrink-0';
    title.textContent = 'FluidCAD Hub';
    this.offlineDot = document.createElement('span');
    this.offlineDot.dataset.ref = 'offline-dot';
    this.offlineDot.className = 'size-1.5 rounded-full bg-error shrink-0 hidden';
    this.offlineDot.title = 'The hub doesn’t answer';
    const spacer = document.createElement('span');
    spacer.className = 'ml-auto';
    this.account = new HubAccount({
      hub: deps.hub,
      openExternal: (url) => deps.openExternal(url),
      onPublisher: (handle) => this.showPublisher(handle),
      onSignedIn: () => this.signedIn(),
      hubHost: () => this.host(),
      timers: deps.timers,
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.ref = 'close';
    close.className = 'btn btn-ghost btn-square btn-xs text-base-content/60';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the Hub panel');
    close.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-4'));
    close.addEventListener('click', () => this.close());
    header.append(title, this.offlineDot, spacer, this.account.el, close);

    this.search = new HubSearchView({
      state: this.state,
      onOpen: (name) => void this.openPackage(name),
      onPublisher: (handle) => this.showPublisher(handle),
      hubHost: () => this.host(),
      engine: () => this.engine(),
    });
    this.detail = new HubPackageView({
      hub: deps.hub,
      packages: deps.packages,
      target: this.target,
      engine: () => this.engine(),
      hubUrl: () => this.status?.hubUrl ?? null,
      projectOpen: () => deps.projectOpen(),
      openExternal: (url) => deps.openExternal(url),
      onBack: () => this.showSearch(),
      onPublisher: (handle) => this.showPublisher(handle),
      onInstalled: (installed) => {
        this.searchStale = true;
        deps.onPackagesChanged(installed);
      },
    });
    this.detail.el.classList.add('hidden');
    this.state.subscribe((snapshot) => {
      this.offlineDot.classList.toggle('hidden', snapshot.mode !== 'offline');
    });

    this.el.append(header, this.account.strip, this.search.el, this.detail.el, this.resizeHandle());
    deps.container.appendChild(this.el);
    this.renderAccount();
    window.addEventListener('resize', this.onResize);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  /** Open the panel on the search (its first open searches and reads the status). */
  show(): void {
    if (!this.open) {
      this.deps.onTakeSlot?.();
      this.width = HubPanel.clampWidth(this.deps.width());
      this.open = true;
      this.el.classList.remove('hidden');
      this.applyWidth(true);
      this.deps.onOpenChange?.(true);
    }
    void this.refreshStatus();
    void this.account.resume();
    if (!this.state.started) {
      this.state.search();
    } else if (this.searchStale && this.view === 'search') {
      this.searchStale = false;
      this.state.refresh();
    }
    if (this.view === 'search') {
      this.search.focus();
    }
  }

  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.el.classList.add('hidden');
    HubPanel.setWidthVariable(0, true);
    this.deps.onOpenChange?.(false);
  }

  /**
   * The code editor took the slot: hide without touching the width it
   * already set for itself.
   */
  yieldSlot(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.el.classList.add('hidden');
    this.deps.onOpenChange?.(false);
  }

  /** Open a package's detail directly (a row; tests). */
  async openPackage(name: string): Promise<void> {
    this.searchScroll = this.search.el.querySelector<HTMLElement>('[data-ref="results"]')?.scrollTop ?? 0;
    this.view = 'package';
    this.search.el.classList.add('hidden');
    this.detail.el.classList.remove('hidden');
    await this.detail.show(name);
  }

  /** Back to the results where they were; their marks are read again after an install. */
  showSearch(): void {
    this.view = 'search';
    this.detail.el.classList.add('hidden');
    this.search.el.classList.remove('hidden');
    const results = this.search.el.querySelector<HTMLElement>('[data-ref="results"]');
    if (results) {
      results.scrollTop = this.searchScroll;
    }
    if (this.searchStale) {
      this.searchStale = false;
      this.state.refresh();
    }
  }

  /**
   * A publisher's packages (a clicked handle): the search for `@handle`,
   * every filter cleared, page 1, the sort kept; from a package's detail
   * too, which goes back to the results for it.
   */
  showPublisher(handle: string): void {
    this.searchScroll = 0;
    this.searchStale = false;
    if (this.view === 'package') {
      this.view = 'search';
      this.detail.el.classList.add('hidden');
      this.search.el.classList.remove('hidden');
    }
    this.state.showPublisher(handle);
    const results = this.search.el.querySelector<HTMLElement>('[data-ref="results"]');
    if (results) {
      results.scrollTop = 0;
    }
  }

  /** The library or the project changed elsewhere (an install from the banner, a removal): the marks are read again. */
  packagesChanged(): void {
    if (this.view === 'search') {
      this.state.refresh();
    } else {
      this.searchStale = true;
      void this.detail.reload();
    }
  }

  get currentView(): 'search' | 'package' {
    return this.view;
  }

  get hubStatus(): HubStatus | null {
    return this.status;
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.account.destroy();
    this.state.dispose();
    this.search.destroy();
    this.detail.destroy();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  private async refreshStatus(): Promise<void> {
    const answer = await this.deps.hub.status();
    if (answer.ok === false) {
      return;
    }
    this.status = answer.status;
    this.renderAccount();
  }

  private renderAccount(): void {
    this.offlineDot.classList.toggle('hidden', this.status?.reachable !== false && this.state.snapshot.mode !== 'offline');
    this.account.setStatus(this.status);
  }

  /** A sign-in from the header finished: the status names the handle; an open package is read again (an owner sees more). */
  private signedIn(): void {
    void this.refreshStatus();
    if (this.view === 'package') {
      void this.detail.reload();
    }
  }

  private host(): string | null {
    if (!this.status) {
      return null;
    }
    try {
      return new URL(this.status.hubUrl).host;
    } catch {
      return this.status.hubUrl;
    }
  }

  private engine(): HubEngine {
    return { engine: this.status?.engine ?? null, sdk: this.status?.sdk ?? null };
  }

  // ---------------------------------------------------------------------------
  // The slot's width, as the editor pane takes it
  // ---------------------------------------------------------------------------

  private applyWidth(animate: boolean): void {
    if (window.innerWidth < MOBILE_BREAKPOINT) {
      this.el.style.width = 'calc(100% - var(--fluidcad-rail-width, 0px))';
      HubPanel.setWidthVariable(0, animate);
      return;
    }
    this.el.style.width = `${this.width}px`;
    HubPanel.setWidthVariable(this.width, animate);
  }

  private setWidth(width: number): void {
    this.width = HubPanel.clampWidth(width);
    if (this.open) {
      this.applyWidth(false);
    }
    this.deps.onWidthChange?.(this.width);
  }

  private static setWidthVariable(value: number, animate: boolean): void {
    const root = document.documentElement;
    root.classList.toggle('fluidcad-editor-animating', animate);
    root.style.setProperty(WIDTH_VARIABLE, `${value}px`);
    if (animate) {
      window.setTimeout(() => root.classList.remove('fluidcad-editor-animating'), 220);
    }
  }

  private static clampWidth(width: number): number {
    const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fluidcad-rail-width')) || 0;
    const max = Math.max(MIN_WIDTH, window.innerWidth - rail - MIN_SCENE_WIDTH);
    return Math.round(Math.min(max, Math.max(MIN_WIDTH, Number.isFinite(width) ? width : 420)));
  }

  private resizeHandle(): HTMLElement {
    const handle = document.createElement('div');
    handle.dataset.ref = 'resize';
    handle.className = 'absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors';
    handle.title = 'Drag to resize';
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = this.width;
      const onMove = (move: PointerEvent) => this.setWidth(startWidth + (move.clientX - startX));
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
    return handle;
  }

  private readonly onResize = (): void => {
    if (this.open) {
      this.applyWidth(false);
    }
  };
}
