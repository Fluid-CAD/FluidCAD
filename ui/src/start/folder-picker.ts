import { ICON_CLOSE, ICON_CUBE, ICON_FOLDER, ICON_FOLDER_UP, ICON_HOME } from '../ui/icons';
import { shortenPath } from './format';
import type { FolderCheck, FolderListing, ProjectDialogs } from './host';

type PageDialogs = Extract<ProjectDialogs, { kind: 'page' }>;

export type FolderPickerMode = 'open' | 'create';

export type FolderPickerHandlers = {
  /**
   * Open the project in `path`. Called inside the click that chose it: a
   * browser opens the project's tab only while it handles the user's gesture.
   */
  open(path: string): void;
  /** Set a new project up at `path` and open it; inside the click, like {@link open}. */
  create(path: string): void;
};

/** Where the picker was last, per browser: the next one starts there. */
const LAST_FOLDER_KEY = 'fluidcad.start.lastFolder';

/** How long typing in the name waits before asking what it would create. */
const CHECK_DELAY_MS = 150;

const ROW =
  'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-left text-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-primary/40';
const ROW_IDLE = `${ROW} text-base-content hover:bg-base-content/[0.06]`;
const ROW_SELECTED = `${ROW} bg-primary/15 text-base-content`;

type StatusTone = 'neutral' | 'error';

const COPY: Record<FolderPickerMode, { title: string; lede: string; action: string }> = {
  open: {
    title: 'Open a project',
    lede: 'Pick the folder that holds your project. It opens in a new tab.',
    action: 'Open',
  },
  create: {
    title: 'New project',
    lede: 'Go to the folder the project should live in, and name it. FluidCAD creates a folder with that name and sets the project up inside it.',
    action: 'Create project',
  },
};

function readLastFolder(): string | null {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}

function rememberFolder(folder: string): void {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, folder);
  } catch {
    // A private window: the next picker starts from the default place.
  }
}

function baseName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? folder;
}

/**
 * The start page's own folder picker, for a browser: under `npx fluidcad` a
 * page cannot show the operating system's folder dialog and get a real path
 * back, so it browses folders the launcher lists instead. The desktop app
 * never shows it; it has native dialogs.
 *
 * Click a folder to select it, double-click to look inside it; a project
 * double-clicked in the Open picker opens. The New Project picker sets the
 * project up in a new folder named after it, inside the folder on show, and
 * says before anything happens what that would create.
 *
 * Built like the engine dialog: a fixed overlay, a header with a close button,
 * a scrolling body and a footer of actions.
 */
export class FolderPicker {
  readonly element: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly lede: HTMLParagraphElement;
  private readonly nav: HTMLDivElement;
  private readonly pathInput: HTMLInputElement;
  private readonly homeBtn: HTMLButtonElement;
  private readonly upBtn: HTMLButtonElement;
  private readonly roots: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly nameRow: HTMLLabelElement;
  private readonly nameInput: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly actionBtn: HTMLButtonElement;
  private mode: FolderPickerMode = 'open';
  private listing: FolderListing | null = null;
  private selected: string | null = null;
  /** What the typed name would create, once asked; stale while a newer check runs. */
  private checked: FolderCheck | null = null;
  private checkRun = 0;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  /** The home directory, for showing `~/…` paths. */
  private home = '';
  /**
   * The folder every project lives in, when the launcher keeps them in one:
   * the picker then browses nothing, and New Project is a name and a button.
   */
  private root: string | null = null;

  constructor(
    private readonly dialogs: PageDialogs,
    private readonly handlers: FolderPickerHandlers,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-4 hidden';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', 'fluidcad-folder-picker-title');
    this.element.innerHTML = `
      <div class="w-[620px] max-w-full max-h-[85vh] flex flex-col bg-base-100 border border-base-content/10 rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base-content/10 shrink-0">
          <h3 id="fluidcad-folder-picker-title" data-ref="title" class="text-sm font-medium text-base-content/90"></h3>
          <button data-ref="close" type="button" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div class="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4">
          <p data-ref="lede" class="text-sm text-base-content/70"></p>
          <div data-ref="nav" class="flex items-center gap-1.5">
            <button data-ref="home" type="button" class="btn btn-sm btn-ghost btn-square" title="Home folder" aria-label="Home folder">
              <span class="[&>svg]:size-4">${ICON_HOME}</span>
            </button>
            <button data-ref="up" type="button" class="btn btn-sm btn-ghost btn-square" title="The folder above" aria-label="The folder above">
              <span class="[&>svg]:size-4">${ICON_FOLDER_UP}</span>
            </button>
            <input data-ref="path" type="text" spellcheck="false" aria-label="Folder" class="input input-sm flex-1 min-w-0 font-mono text-xs" />
          </div>
          <div data-ref="roots" class="hidden flex flex-wrap gap-1"></div>
          <div data-ref="list" role="listbox" aria-label="Folders" class="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto border border-base-content/10 rounded-md p-1"></div>
          <label data-ref="name-row" class="hidden flex items-center gap-3">
            <span class="text-sm text-base-content/80 shrink-0">Project name</span>
            <input data-ref="name" type="text" spellcheck="false" placeholder="e.g. bracket" class="input input-sm flex-1 min-w-0" />
          </label>
          <div data-ref="status" class="min-h-5 text-xs text-base-content/60 break-words" aria-live="polite"></div>
        </div>
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-content/10 shrink-0">
          <button data-ref="cancel" type="button" class="btn btn-sm btn-ghost">Cancel</button>
          <button data-ref="action" type="button" class="btn btn-sm btn-primary"></button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string) => this.element.querySelector<T>(`[data-ref="${name}"]`)!;
    this.title = ref('title');
    this.lede = ref('lede');
    this.nav = ref('nav');
    this.pathInput = ref('path');
    this.homeBtn = ref('home');
    this.upBtn = ref('up');
    this.roots = ref('roots');
    this.list = ref('list');
    this.nameRow = ref('name-row');
    this.nameInput = ref('name');
    this.status = ref('status');
    this.actionBtn = ref('action');

    ref<HTMLButtonElement>('close').addEventListener('click', () => this.close());
    ref<HTMLButtonElement>('cancel').addEventListener('click', () => this.close());
    this.homeBtn.addEventListener('click', () => void this.browse(this.listing?.home ?? null));
    this.upBtn.addEventListener('click', () => {
      if (this.listing?.parent) {
        void this.browse(this.listing.parent);
      }
    });
    this.pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.browse(this.pathInput.value.trim() || null);
      }
    });
    this.nameInput.addEventListener('input', () => this.scheduleCheck());
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.act();
      }
    });
    this.actionBtn.addEventListener('click', () => this.act());
    this.element.addEventListener('mousedown', (event) => {
      if (event.target === this.element) {
        this.close();
      }
    });
    // Capture phase, like the other dialogs: the picker is on top, so its Escape is its own.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.isOpen()) {
          event.stopPropagation();
          event.preventDefault();
          this.close();
        }
      },
      true,
    );
  }

  /** Showing, in the page: a picker that left the document keeps no hold on its keys. */
  isOpen(): boolean {
    return this.element.isConnected && !this.element.classList.contains('hidden');
  }

  /**
   * Show the picker, starting where it was last (or next to the latest
   * project). With a projects folder (`root`), there is nowhere to browse: a
   * new project is named, and made in that folder.
   */
  async show(mode: FolderPickerMode, root: string | null = null): Promise<void> {
    this.mode = mode;
    this.root = root;
    const rooted = root !== null;
    this.title.textContent = COPY[mode].title;
    this.lede.textContent =
      rooted && mode === 'create' ? 'Name the project. FluidCAD sets it up in your projects folder and opens it.' : COPY[mode].lede;
    this.nav.classList.toggle('hidden', rooted);
    this.list.classList.toggle('hidden', rooted && mode === 'create');
    this.nameRow.classList.toggle('hidden', mode !== 'create');
    this.nameInput.value = '';
    this.checked = null;
    this.selected = null;
    this.listing = null;
    this.list.replaceChildren();
    this.setStatus('', 'neutral');
    this.sync();
    this.element.classList.remove('hidden');
    if (rooted) {
      await this.browse(root);
    } else {
      const last = readLastFolder();
      if (!(await this.browse(last)) && last !== null) {
        await this.browse(null);
      }
    }
    (mode === 'create' ? this.nameInput : this.list.querySelector<HTMLElement>('button') ?? this.pathInput).focus();
  }

  close(): void {
    this.element.classList.add('hidden');
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    this.checkRun += 1;
  }

  /** List `folder` (null: the launcher's default place). False when it could not be listed. */
  private async browse(folder: string | null): Promise<boolean> {
    let listing: FolderListing;
    try {
      listing = await this.dialogs.browse(folder);
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), 'error');
      return false;
    }
    this.listing = listing;
    this.home = listing.home;
    this.selected = null;
    this.pathInput.value = listing.path;
    // The end of a long path is the part that says where this is.
    this.pathInput.scrollLeft = this.pathInput.scrollWidth;
    if (this.root === null) {
      // A projects folder is the launcher's choice, not a place to come back to.
      rememberFolder(listing.path);
    }
    this.renderRoots(listing);
    this.renderList(listing);
    if (this.mode === 'create') {
      this.scheduleCheck(0);
    } else {
      this.describeOpenTarget();
    }
    this.sync();
    return true;
  }

  private renderRoots(listing: FolderListing): void {
    this.roots.classList.toggle('hidden', listing.roots.length < 2);
    this.roots.replaceChildren(
      ...listing.roots.map((root) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-xs btn-ghost font-mono';
        button.textContent = root;
        button.addEventListener('click', () => void this.browse(root));
        return button;
      }),
    );
  }

  private renderList(listing: FolderListing): void {
    if (listing.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'px-2.5 py-6 text-center text-xs text-base-content/50';
      empty.textContent = 'No folders here.';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(
      ...listing.entries.map((entry) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = ROW_IDLE;
        row.setAttribute('role', 'option');
        row.dataset.path = entry.path;
        row.title = entry.path;
        const icon = document.createElement('span');
        icon.className = `shrink-0 [&>svg]:size-4 ${entry.project ? 'text-primary' : 'text-base-content/50'}`;
        icon.innerHTML = entry.project ? ICON_CUBE : ICON_FOLDER;
        const name = document.createElement('span');
        name.className = 'flex-1 min-w-0 truncate';
        name.textContent = entry.name;
        row.append(icon, name);
        if (entry.project) {
          const badge = document.createElement('span');
          badge.className = 'badge badge-sm badge-outline text-base-content/60 border-base-content/20 shrink-0';
          badge.textContent = 'project';
          row.appendChild(badge);
        }
        row.addEventListener('click', () => this.select(entry.path));
        row.addEventListener('dblclick', () => {
          if (this.mode === 'open' && entry.project) {
            this.choose(entry.path);
          } else {
            void this.browse(entry.path);
          }
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void this.browse(entry.path);
          }
        });
        return row;
      }),
    );
  }

  private select(folder: string): void {
    this.selected = this.selected === folder ? null : folder;
    for (const row of this.list.querySelectorAll<HTMLElement>('[data-path]')) {
      const isSelected = row.dataset.path === this.selected;
      row.className = isSelected ? ROW_SELECTED : ROW_IDLE;
      row.setAttribute('aria-selected', String(isSelected));
    }
    if (this.mode === 'open') {
      this.describeOpenTarget();
    }
    this.sync();
  }

  /** The folder Open would open: the one selected, else the one shown. */
  private openTarget(): { path: string; project: boolean } | null {
    if (!this.listing) {
      return null;
    }
    const selected = this.listing.entries.find((entry) => entry.path === this.selected);
    return selected ? { path: selected.path, project: selected.project } : { path: this.listing.path, project: this.listing.project };
  }

  private describeOpenTarget(): void {
    const target = this.openTarget();
    if (!target) {
      return;
    }
    const name = baseName(target.path);
    this.setStatus(
      target.project
        ? `Opens ${name} in a new tab.`
        : `${name} holds no FluidCAD project yet. It opens empty, ready for a first model.`,
      'neutral',
    );
  }

  private scheduleCheck(delay = CHECK_DELAY_MS): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }
    this.checked = null;
    this.sync();
    const name = this.nameInput.value.trim();
    if (!name) {
      this.setStatus('Name the project. The name becomes its folder.', 'neutral');
      return;
    }
    this.checkTimer = setTimeout(() => void this.runCheck(name), delay);
  }

  private async runCheck(name: string): Promise<void> {
    this.checkTimer = null;
    const parent = this.listing?.path;
    if (!parent) {
      return;
    }
    const run = ++this.checkRun;
    let result: FolderCheck;
    try {
      result = await this.dialogs.check(parent, name);
    } catch (err) {
      if (run === this.checkRun) {
        this.setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
      return;
    }
    if (run !== this.checkRun) {
      return;
    }
    this.checked = result;
    this.describeCheck(result);
    this.sync();
  }

  private describeCheck(result: FolderCheck): void {
    // In a projects folder the name says it all; anywhere else, where it lands.
    const where = this.root === null ? shortenPath(result.path, this.home) : baseName(result.path);
    switch (result.state) {
      case 'missing':
        this.setStatus(`Creates ${where} and opens it in a new tab.`, 'neutral');
        return;
      case 'empty':
        this.setStatus(`Sets the project up in the empty folder ${where}.`, 'neutral');
        return;
      case 'project':
        this.setStatus(`${where} already holds a project. Choose another name, or open that one.`, 'error');
        return;
      case 'not-empty':
        this.setStatus(`${where} already exists and is not empty. Choose another name.`, 'error');
        return;
      case 'not-a-folder':
        this.setStatus(`${where} is a file. Choose another name.`, 'error');
        return;
      case 'invalid-name':
        this.setStatus('A folder name cannot use / \\ : * ? " < > | or end with a dot or a space.', 'error');
        return;
      case 'unreadable':
        this.setStatus('FluidCAD cannot use this folder. Choose another one.', 'error');
        return;
    }
  }

  private canAct(): boolean {
    if (!this.listing) {
      return false;
    }
    if (this.mode === 'open') {
      return true;
    }
    return this.checked !== null && (this.checked.state === 'missing' || this.checked.state === 'empty');
  }

  /** Buttons, from where the picker is and what it would do. */
  private sync(): void {
    this.upBtn.disabled = !this.listing?.parent;
    this.homeBtn.disabled = !this.listing;
    this.actionBtn.disabled = !this.canAct();
    if (this.mode === 'open') {
      const target = this.openTarget();
      this.actionBtn.textContent = target ? `Open ${baseName(target.path)}` : COPY.open.action;
    } else {
      this.actionBtn.textContent = COPY.create.action;
    }
  }

  private act(): void {
    if (!this.canAct()) {
      return;
    }
    if (this.mode === 'open') {
      const target = this.openTarget();
      if (target) {
        this.choose(target.path);
      }
      return;
    }
    this.choose(this.checked!.path);
  }

  /** Hand the folder over, inside this click, and get out of the way. */
  private choose(folder: string): void {
    this.close();
    if (this.mode === 'open') {
      this.handlers.open(folder);
    } else {
      this.handlers.create(folder);
    }
  }

  private setStatus(text: string, tone: StatusTone): void {
    this.status.textContent = text;
    this.status.className = `min-h-5 text-xs break-words ${tone === 'error' ? 'text-error' : 'text-base-content/60'}`;
    this.status.dataset.tone = tone;
  }
}
