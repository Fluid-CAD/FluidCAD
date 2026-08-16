import { ICON_CUBE, ICON_FILE_CODE, ICON_CLOSE, ICON_ALERT_DOT, ICON_PLUS } from '../ui/icons';
import { ToolbarScroller } from '../ui/navbar/toolbar-scroller';
import { ICON_IMG_FALLBACK } from '../ui/object-icons';
import type { FileKind } from './editor-api';

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
  onClose(absPath: string): void;
  /** The `+` button — the caller opens the quick-open popover under it. */
  onAdd(anchor: HTMLElement): void;
}

type ModelType = 'Part' | 'Assembly';
type ModelName = { stem: string; type: ModelType };

/** Model suffixes and the type they announce, in match order. */
const MODEL_SUFFIXES: ReadonlyArray<readonly [string, ModelType]> = [
  ['.assembly.js', 'Assembly'],
  ['.part.js', 'Part'],
  ['.fluid.js', 'Part'],
];

const TAB_BASE =
  'group relative flex items-center gap-1.5 h-full pl-2 pr-1.5 text-sm ' +
  'max-w-[200px] cursor-pointer select-none transition-colors shrink-0';

export class FileTabs {
  private readonly bar: HTMLDivElement;
  private readonly scroller: ToolbarScroller;
  private readonly addButton: HTMLButtonElement;
  /** `?editor=0`: a plain file name, no tab or `+` affordances at all. */
  private readonly labelOnly: HTMLSpanElement;
  private tabs: FileTab[] = [];
  private activePath: string | null = null;
  /** The model the scene belongs to — not necessarily the active tab. */
  private currentModelPath: string | null = null;

  constructor(container: HTMLElement, private readonly handlers: FileTabsHandlers, tabsEnabled: boolean) {
    // `self-stretch` against the top bar's `items-center`, so full-height tabs
    // reach the bar's bottom border instead of floating inside it.
    this.bar = document.createElement('div');
    this.bar.className = 'flex items-center gap-1 min-w-0 self-stretch';

    this.labelOnly = document.createElement('span');
    this.labelOnly.className = 'text-sm text-base-content/70 truncate max-w-[40vw]';

    if (tabsEnabled) {
      // Shrink-to-fit up to a cap, so `+` sits next to the last tab rather
      // than being pushed to the far end of the bar.
      // `[&>div]:h-full` reaches the scroller's viewport (its only div child;
      // the arrows are buttons), which the class on the track can't.
      const scrollHost = document.createElement('div');
      scrollHost.className = 'relative flex items-center min-w-0 max-w-[45vw] h-full [&>div]:h-full';
      this.bar.appendChild(scrollHost);
      this.scroller = new ToolbarScroller(scrollHost);
      this.scroller.track.classList.add('h-full');
      this.addButton = this.buildAddButton();
      this.bar.appendChild(this.addButton);
    } else {
      // Still constructed, never attached — keeps every branch below free of
      // null checks for a mode that simply has no tabs.
      this.scroller = new ToolbarScroller(document.createElement('div'));
      this.addButton = this.buildAddButton();
      this.bar.appendChild(this.labelOnly);
    }

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
    this.render();
  }

  private buildAddButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className =
      'btn btn-ghost btn-square btn-xs text-base-content/50 hover:text-base-content shrink-0';
    button.title = 'Open a file';
    button.innerHTML = `<span class="[&>svg]:size-4">${ICON_PLUS}</span>`;
    button.addEventListener('click', () => this.handlers.onAdd(button));
    return button;
  }

  private render(): void {
    this.scroller.track.replaceChildren();
    for (const tab of this.tabs) {
      this.scroller.track.appendChild(this.buildTab(tab));
    }
    this.scroller.refresh();
  }

  private buildTab(tab: FileTab): HTMLElement {
    const isActive = tab.absPath === this.activePath;
    const isCurrentModel = tab.absPath === this.currentModelPath;

    const el = document.createElement('div');
    el.className = `${TAB_BASE} ${
      isActive
        ? 'bg-base-300 text-base-content'
        : 'text-base-content/60 hover:bg-base-content/5 hover:text-base-content/90'
    }`;
    el.title = tab.relPath;
    el.addEventListener('click', () => this.handlers.onActivate(tab.absPath));

    const basename = tab.relPath.split('/').pop() || tab.relPath;
    const model = FileTabs.splitModelName(basename);
    el.appendChild(FileTabs.buildIcon(tab, model, isCurrentModel));
    el.appendChild(FileTabs.buildLabel(basename, model));

    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'shrink-0 text-warning [&>svg]:size-2';
      dot.title = 'Unsaved changes';
      dot.innerHTML = ICON_ALERT_DOT;
      el.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className =
      'shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 ' +
      'hover:bg-base-content/15 [&>svg]:size-3 ' +
      (isActive ? 'opacity-70' : '');
    close.title = 'Close tab';
    close.innerHTML = ICON_CLOSE;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.onClose(tab.absPath);
    });
    el.appendChild(close);

    // The scene belongs to the current model — an underline says so without
    // competing with the active-tab background.
    if (isCurrentModel) {
      const rule = document.createElement('span');
      rule.className = 'absolute left-0 right-0 -bottom-px h-0.5 bg-primary';
      el.appendChild(rule);
    }

    return el;
  }

  /**
   * The scene's own file wears its icon in full strength; another open model
   * wears it dimmed, and a helper gets the quieter file icon. An assembly
   * shows the toolbar's assembly picture, a part the cube — the same pair the
   * rest of the UI uses to tell the two apart. The picture is a raster, so it
   * dims by opacity where the SVG cube dims by colour.
   */
  private static buildIcon(tab: FileTab, model: ModelName | null, isCurrentModel: boolean): HTMLElement {
    const icon = document.createElement('span');
    if (model?.type === 'Assembly') {
      icon.className = `shrink-0 ${isCurrentModel ? '' : 'opacity-40'}`;
      icon.innerHTML =
        `<img src="/icons/assembly.png" ${ICON_IMG_FALLBACK} class="size-4 object-contain" alt="" />`;
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
      label.className = 'truncate';
      label.textContent = basename;
      return label;
    }

    const label = document.createElement('span');
    label.className = 'flex flex-col min-w-0 leading-tight';

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

  /** `bracket.part.js` → `{ stem: 'bracket', type: 'Part' }`; null for anything else. */
  private static splitModelName(basename: string): ModelName | null {
    for (const [suffix, type] of MODEL_SUFFIXES) {
      if (basename.endsWith(suffix) && basename.length > suffix.length) {
        return { stem: basename.slice(0, -suffix.length), type };
      }
    }
    return null;
  }
}
