import { ICON_CUBE, ICON_FILE_CODE, ICON_CLOSE, ICON_ALERT_DOT, ICON_PLUS, ICON_PENCIL } from '../ui/icons';
import { ToolbarScroller } from '../ui/navbar/toolbar-scroller';
import type { FileKind } from './editor-api';
import { TabReorder } from './tab-reorder';
import { buildRenameField, editableNameOf, renamedBasename } from './tab-rename';
import { ASSEMBLY_ACCENT, splitModelName, type ModelName } from './model-name';
import { closeTabMenu, showTabMenu, type TabMenuItem } from './tab-menu';

/**
 * The top bar's file tabs — the whole file-navigation surface, in place of a
 * tree. The tree's real job (telling the language service what exists) is done
 * invisibly by loading a model per workspace file, which leaves tabs free to be
 * only what the user is actually looking at
 * (`docs/desktop/05-editor-surface-design.md`).
 *
 * Tabs carry a **kind**, and the difference matters:
 *
 * - `model` — a `.part.js`, `.assembly.js` or `.fluid.js`. Activating it
 *   re-renders the scene. Exactly one is current, and that one has to be
 *   unmistakable: the scene belongs to it.
 * - `source` — a plain `.js` helper, `init.js`. Editor-only; activating it
 *   leaves the viewport showing whatever model is current.
 *
 * Tabs can be dragged into a new order ({@link TabReorder}) and renamed in
 * place from their right-click menu — a rename is a rename of the file, and
 * the strip only asks; the owner does it.
 *
 * No monaco import here, deliberately: the top bar is loaded on every page,
 * including the viewport-only hosts that never fetch the editor chunk.
 */

export type FileTab = {
  absPath: string;
  /** Workspace-relative, used for the label and for disambiguating basenames. */
  relPath: string;
  kind: FileKind;
  dirty: boolean;
};

export interface FileTabsHandlers {
  onActivate(absPath: string): void;
  /** Absent on a host whose tab set is fixed (the viewer's package files): no close buttons. */
  onClose?(absPath: string): void;
  /** The `+` button — the caller opens the quick-open popover under it. Absent: no `+`. */
  onAdd?(anchor: HTMLElement): void;
  /** The tabs were dragged into a new order. Absent: tabs don't drag. */
  onReorder?(absPaths: string[]): void;
  /**
   * The user renamed a tab: rename the file to `newBasename` (in its own
   * folder). Absent: no Rename in the tab menu.
   */
  onRename?(absPath: string, newBasename: string): void;
}

/**
 * Tabs keep a floor width so a short stem (`main`) doesn't collapse the tab
 * to its icon, and a ceiling so a long one truncates instead of eating the bar.
 */
const TAB_MIN_WIDTH = 112;
const TAB_MAX_WIDTH = 200;

const TAB_BASE =
  'group relative flex items-center gap-2 h-full pl-3 pr-2 text-sm ' +
  'cursor-pointer select-none transition-colors shrink-0';

/** An in-progress rename: which tab, and what the field holds so far. */
type Renaming = {
  absPath: string;
  draft: string;
  /** The field hasn't been shown yet — select its text when it first appears. */
  fresh: boolean;
};

export class FileTabs {
  private readonly bar: HTMLDivElement;
  private readonly scroller: ToolbarScroller;
  private readonly reorder: TabReorder;
  private readonly addButton: HTMLButtonElement;
  /** `?editor=0`: a plain file name, no tab or `+` affordances at all. */
  private readonly labelOnly: HTMLSpanElement;
  private tabs: FileTab[] = [];
  private activePath: string | null = null;
  /** The model the scene belongs to — not necessarily the active tab. */
  private currentModelPath: string | null = null;
  private renaming: Renaming | null = null;

  constructor(container: HTMLElement, private readonly handlers: FileTabsHandlers, tabsEnabled: boolean) {
    // `self-stretch` against the top bar's `items-center`, so full-height tabs
    // reach the bar's bottom border instead of floating inside it.
    this.bar = document.createElement('div');
    this.bar.className = 'flex items-center gap-1 min-w-0 self-stretch';

    this.labelOnly = document.createElement('span');
    this.labelOnly.className = 'text-sm text-base-content/70 truncate max-w-[40vw]';

    if (tabsEnabled) {
      // Shrink-to-fit: the host sizes to its tabs (keeping `+` next to the
      // last one) and, as the only shrinkable item in the top bar, gives way
      // exactly when the bar itself runs out of room — which is when the
      // scroller's arrows should appear, and not before.
      // `[&>div]:h-full` reaches the scroller's viewport (its only div child;
      // the arrows are buttons), which the class on the track can't.
      const scrollHost = document.createElement('div');
      scrollHost.className = 'relative flex items-center min-w-0 h-full [&>div]:h-full';
      this.bar.appendChild(scrollHost);
      this.scroller = new ToolbarScroller(scrollHost);
      this.scroller.track.classList.add('h-full');
      this.addButton = this.buildAddButton();
      if (handlers.onAdd) {
        this.bar.appendChild(this.addButton);
      }
    } else {
      // Still constructed, never attached — keeps every branch below free of
      // null checks for a mode that simply has no tabs.
      this.scroller = new ToolbarScroller(document.createElement('div'));
      this.addButton = this.buildAddButton();
      this.bar.appendChild(this.labelOnly);
    }
    this.reorder = new TabReorder(this.scroller.track, {
      onReorder: (absPaths) => this.handlers.onReorder?.(absPaths),
    });

    container.appendChild(this.bar);
  }

  /** Viewport-only hosts keep the plain label `setFileName` always showed. */
  setFileName(absPath: string): void {
    this.labelOnly.textContent = absPath.split('/').pop() || absPath;
  }

  getTabs(): FileTab[] {
    return this.tabs.slice();
  }

  /**
   * The `+` button, for anchoring quick-open to. The desktop menu's Find File
   * has no click target of its own, and a popover has to hang off something
   * the user can see.
   */
  get addAnchor(): HTMLElement {
    return this.addButton;
  }

  setTabs(tabs: FileTab[], activePath: string | null, currentModelPath: string | null): void {
    this.tabs = tabs;
    this.activePath = activePath;
    this.currentModelPath = currentModelPath;
    // A rename outlives a re-render, but not its tab.
    if (this.renaming && !tabs.some((tab) => tab.absPath === this.renaming!.absPath)) {
      this.renaming = null;
    }
    this.render();
  }

  /** Put `absPath`'s label into edit mode — what the menu's Rename does. */
  beginRename(absPath: string): void {
    const tab = this.tabs.find((candidate) => candidate.absPath === absPath);
    if (!tab || !this.handlers.onRename) {
      return;
    }
    this.renaming = { absPath, draft: editableNameOf(FileTabs.basenameOf(tab)), fresh: true };
    this.render();
  }

  private buildAddButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className =
      'btn btn-ghost btn-square btn-xs text-base-content/50 hover:text-base-content shrink-0';
    button.title = 'Open a file';
    button.innerHTML = `<span class="[&>svg]:size-4">${ICON_PLUS}</span>`;
    button.addEventListener('click', () => this.handlers.onAdd?.(button));
    return button;
  }

  private render(): void {
    closeTabMenu();
    this.scroller.track.replaceChildren();
    let field: HTMLInputElement | null = null;
    for (const tab of this.tabs) {
      const el = this.buildTab(tab);
      this.scroller.track.appendChild(el);
      field ??= el.querySelector<HTMLInputElement>('[data-rename-input]');
    }
    this.scroller.refresh();
    if (field && this.renaming) {
      // Focus after the field is in the document: a strip re-render mid-rename
      // rebuilt it, and the caret must land back where typing continues.
      field.focus();
      if (this.renaming.fresh) {
        field.select();
        this.renaming.fresh = false;
      } else {
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
  }

  private buildTab(tab: FileTab): HTMLElement {
    const isActive = tab.absPath === this.activePath;
    const isCurrentModel = tab.absPath === this.currentModelPath;
    const isRenaming = this.renaming?.absPath === tab.absPath;

    const el = document.createElement('div');
    el.className = `${TAB_BASE} ${
      isActive
        ? 'bg-base-300 text-base-content'
        : 'text-base-content/60 hover:bg-base-content/5 hover:text-base-content/90'
    }`;
    el.style.minWidth = `${TAB_MIN_WIDTH}px`;
    el.style.maxWidth = `${TAB_MAX_WIDTH}px`;
    el.title = tab.relPath;
    el.addEventListener('click', (event) => {
      // The click that ends a drag is the drag's, and a click in the rename
      // field is typing.
      if (this.reorder.consumeClick() || (event.target as HTMLElement).closest('[data-rename-input]')) {
        return;
      }
      this.handlers.onActivate(tab.absPath);
    });
    if (this.handlers.onReorder) {
      this.reorder.attach(el, tab.absPath);
    }
    const menuItems = this.menuItemsFor(tab);
    if (menuItems.length > 0) {
      el.addEventListener('contextmenu', (event) => {
        if ((event.target as HTMLElement).closest('[data-rename-input]')) {
          return;
        }
        event.preventDefault();
        showTabMenu(this.menuHost(), event, menuItems);
      });
    }

    const basename = FileTabs.basenameOf(tab);
    const model = splitModelName(basename);
    el.appendChild(FileTabs.buildIcon(tab, model, isCurrentModel));
    el.appendChild(isRenaming ? this.buildRenameField(tab, basename) : FileTabs.buildLabel(basename, model));

    if (tab.dirty && !isRenaming) {
      const dot = document.createElement('span');
      dot.className = 'shrink-0 text-warning [&>svg]:size-2';
      dot.title = 'Unsaved changes';
      dot.innerHTML = ICON_ALERT_DOT;
      el.appendChild(dot);
    }

    if (this.handlers.onClose && !isRenaming) {
      el.appendChild(this.buildCloseButton(tab, isActive));
    }

    // The scene belongs to the current model — an underline says so without
    // competing with the active-tab background.
    if (isCurrentModel) {
      const rule = document.createElement('span');
      rule.className = 'absolute left-0 right-0 -bottom-px h-0.5 bg-primary';
      el.appendChild(rule);
    }

    return el;
  }

  /** The right-click menu's rows for `tab`; empty when the host offers neither action. */
  private menuItemsFor(tab: FileTab): TabMenuItem[] {
    const items: TabMenuItem[] = [];
    if (this.handlers.onRename) {
      items.push({ icon: ICON_PENCIL, label: 'Rename', onSelect: () => this.beginRename(tab.absPath) });
    }
    if (this.handlers.onClose) {
      items.push({ icon: ICON_CLOSE, label: 'Close', onSelect: () => this.handlers.onClose?.(tab.absPath) });
    }
    return items;
  }

  /** Where the tab menu mounts: the viewer container, or the bar's parent before one exists. */
  private menuHost(): HTMLElement {
    return this.bar.closest<HTMLElement>('#fluidcad-viewer') ?? this.bar.parentElement ?? document.body;
  }

  private buildRenameField(tab: FileTab, basename: string): HTMLInputElement {
    const renaming = this.renaming!;
    const finish = () => {
      if (this.renaming === renaming) {
        this.renaming = null;
      }
    };
    return buildRenameField(renaming.draft, {
      onInput: (draft) => {
        renaming.draft = draft;
      },
      onCommit: (typed) => {
        finish();
        const next = renamedBasename(basename, typed);
        if (next) {
          this.handlers.onRename?.(tab.absPath, next);
        }
        // Whether or not the name changed, the label comes back; a rename
        // that goes through re-renders again with the new one.
        this.render();
      },
      onCancel: () => {
        finish();
        this.render();
      },
    });
  }

  private buildCloseButton(tab: FileTab, isActive: boolean): HTMLButtonElement {
    const close = document.createElement('button');
    close.className =
      'shrink-0 ml-1 rounded p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 ' +
      'hover:bg-base-content/15 [&>svg]:size-3 ' +
      (isActive ? 'opacity-70' : '');
    close.title = 'Close tab';
    close.innerHTML = ICON_CLOSE;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.onClose?.(tab.absPath);
    });
    return close;
  }

  /**
   * The scene's own file wears its icon in full strength; another open model
   * wears it dimmed, and a helper gets the quieter file icon. Parts and
   * assemblies share the cube — an assembly's is tinted the assembly accent
   * (the teal the assembly workbench uses) so the two read apart at a glance.
   */
  private static buildIcon(tab: FileTab, model: ModelName | null, isCurrentModel: boolean): HTMLElement {
    const icon = document.createElement('span');
    if (model?.type === 'Assembly') {
      icon.className = `shrink-0 [&>svg]:size-3.5 ${isCurrentModel ? '' : 'opacity-40'}`;
      icon.style.color = ASSEMBLY_ACCENT;
      icon.innerHTML = ICON_CUBE;
      return icon;
    }
    icon.className = `shrink-0 [&>svg]:size-3.5 ${
      isCurrentModel ? 'text-primary' : 'text-base-content/40'
    }`;
    icon.innerHTML = tab.kind === 'model' ? ICON_CUBE : ICON_FILE_CODE;
    return icon;
  }

  /**
   * The name a tab wears. A model drops its type suffix and says the type
   * underneath instead — `bracket` over `Part`, `rig` over `Assembly` — since
   * the suffix is the same on every model tab and only the stem tells them
   * apart. Helpers keep their full basename: `init.js` is its own name.
   */
  private static buildLabel(basename: string, model: ModelName | null): HTMLElement {
    if (!model) {
      const label = document.createElement('span');
      label.className = 'flex-1 truncate';
      label.textContent = basename;
      return label;
    }

    const label = document.createElement('span');
    label.className = 'flex-1 flex flex-col min-w-0 leading-tight';

    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = model.stem;
    label.appendChild(name);

    const type = document.createElement('span');
    type.className = 'truncate text-[10px] text-base-content/50';
    type.textContent = model.type;
    label.appendChild(type);

    return label;
  }

  private static basenameOf(tab: FileTab): string {
    return tab.relPath.split('/').pop() || tab.relPath;
  }
}
