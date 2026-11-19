import { setupMonaco, EDITOR_OPTIONS, monaco } from './monaco-setup';
import { editorPrefOptions, editorPrefs } from './editor-prefs';
import type { LeftSlot, LeftSlotOccupant } from '../ui/left-slot';

/**
 * The code editor's surface: a pane docked to the left of the scene, hidden by
 * default, that **takes width from the viewport rather than covering it**
 * (Invariant 7). The scene is the product; the editor is where you go when the
 * UI can't express something.
 *
 * The resize is free. `SceneContext` already runs a `ResizeObserver` on
 * `#fluidcad-scene`, and `styles.css` insets that element by
 * `--fluidcad-scene-left`, which the left slot's width feeds — so the pane
 * only has to take the slot ({@link LeftSlot} sets that one custom property)
 * and the viewport re-renders itself at the new size, correctly, with no
 * viewer changes at all. `setViewOffset` is deliberately *not* used: that is
 * for overlays occluding a full-size canvas, and this genuinely takes room.
 */

const MIN_WIDTH = 240;

export interface EditorPaneOptions {
  /** `#fluidcad-viewer` — the positioning context every overlay shares. */
  container: HTMLElement;
  /** The left slot the pane shares with the Hub panel, and its width. */
  slot: LeftSlot;
  /**
   * The editor's place in the slot. The page registers it before the editor
   * has loaded, so a panel taking the slot meanwhile can cancel an open that
   * was asked for; its `close()` closes this pane.
   */
  occupant: LeftSlotOccupant;
  initialOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

export class EditorPane {
  private readonly el: HTMLDivElement;
  private readonly editorHost: HTMLDivElement;
  private readonly options: EditorPaneOptions;
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private open = false;

  constructor(options: EditorPaneOptions) {
    this.options = options;

    this.el = document.createElement('div');
    // Docked against the panel rail rather than the window edge — the rail is
    // the outermost chrome on this side, and `--fluidcad-rail-width` is 0px on
    // a host that mounts none.
    this.el.className =
      'absolute left-[var(--fluidcad-rail-width,0px)] top-[var(--fluidcad-chrome-top,104px)] bottom-0 z-[115] ' +
      'flex flex-col bg-base-100 border-r border-base-content/10 hidden';

    this.editorHost = document.createElement('div');
    this.editorHost.className = 'flex-1 min-h-0';
    this.el.appendChild(this.editorHost);

    this.el.appendChild(options.slot.resizeHandle());
    options.container.appendChild(this.el);

    if (options.initialOpen) {
      this.setOpen(true);
    }
  }

  /**
   * Monaco is created on first open, and the editor module itself is a
   * dynamic import — a session that never opens the editor never pays for it.
   * Idempotent, so callers don't have to track whether it happened.
   */
  ensureEditor(): monaco.editor.IStandaloneCodeEditor {
    if (!this.editor) {
      setupMonaco();
      const editor = monaco.editor.create(this.editorHost, {
        ...EDITOR_OPTIONS,
        ...editorPrefOptions(editorPrefs.current),
        overflowWidgetsDomNode: overflowWidgetsHost(),
      });
      // The Settings dialog's font edits land while the editor is up.
      const unsubscribe = editorPrefs.subscribe((prefs) => editor.updateOptions(editorPrefOptions(prefs)));
      editor.onDidDispose(unsubscribe);
      this.editor = editor;
    }
    return this.editor;
  }

  getEditor(): monaco.editor.IStandaloneCodeEditor | null {
    return this.editor;
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (open === this.open) {
      return;
    }
    this.open = open;
    this.el.classList.toggle('hidden', !open);

    if (open) {
      this.ensureEditor();
      // Whatever held the slot (the Hub panel) closes, and the pane takes the
      // shared width — or covers the scene on a phone, the one documented
      // exception to "pushes, never overlays".
      this.options.slot.take(this.options.occupant, { el: this.el, minWidth: MIN_WIDTH });
      // Monaco measures its container on create; if that happened while the
      // pane was still `hidden` it measured zero.
      this.editor?.layout();
      this.editor?.focus();
    } else {
      this.options.slot.release(this.options.occupant);
    }
    this.options.onOpenChange?.(open);
  }
}

let overflowHost: HTMLDivElement | null = null;

/**
 * Where Monaco puts the widgets that overflow its own bounds — hovers,
 * signature help, the suggest list, the find box.
 *
 * They have to leave the pane entirely. The pane sits at `z-115` under the
 * Navbar's `z-120`, so a hover on **line 1** opens upward into the toolbar's
 * band and paints behind it; `fixedOverflowWidgets` alone doesn't help,
 * because `position: fixed` is still resolved inside the pane's stacking
 * context. Hosting them on `document.body` is Monaco's own escape hatch for
 * this, and it's the same fix as the top bar's popovers.
 *
 * The `monaco-editor` class is required: the widget stylesheets are all scoped
 * under it, so without it the hover renders unstyled.
 */
function overflowWidgetsHost(): HTMLDivElement {
  if (!overflowHost) {
    overflowHost = document.createElement('div');
    overflowHost.className = 'monaco-editor fluidcad-monaco-overflow';
    document.body.appendChild(overflowHost);
  }
  return overflowHost;
}
