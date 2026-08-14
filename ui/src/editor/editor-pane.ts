import { setupMonaco, EDITOR_OPTIONS, monaco } from './monaco-setup';

/**
 * The code editor's surface: a pane docked to the left of the scene, hidden by
 * default, that **takes width from the viewport rather than covering it**
 * (Invariant 7). The scene is the product; the editor is where you go when the
 * UI can't express something.
 *
 * The resize is free. `SceneContext` already runs a `ResizeObserver` on
 * `#fluidcad-scene`, and `styles.css` insets that element by
 * `--fluidcad-editor-width` — so this pane only has to set one custom
 * property and the viewport re-renders itself at the new size, correctly, with
 * no viewer changes at all. `setViewOffset` is deliberately *not* used: that
 * is for overlays occluding a full-size canvas, and this genuinely takes room.
 */

const WIDTH_VARIABLE = '--fluidcad-editor-width';
const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 420;
/** Leave at least this much scene visible, however hard the divider is dragged. */
const MIN_SCENE_WIDTH = 280;
/** Below this the split stops making sense and the pane covers the scene instead. */
const MOBILE_BREAKPOINT = 640;

export interface EditorPaneOptions {
  /** `#fluidcad-viewer` — the positioning context every overlay shares. */
  container: HTMLElement;
  initialWidth?: number;
  initialOpen?: boolean;
  onOpenChange?(open: boolean): void;
  onWidthChange?(width: number): void;
}

export class EditorPane {
  private readonly el: HTMLDivElement;
  private readonly editorHost: HTMLDivElement;
  private readonly options: EditorPaneOptions;
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private width: number;
  private open = false;

  constructor(options: EditorPaneOptions) {
    this.options = options;
    this.width = clampWidth(options.initialWidth ?? DEFAULT_WIDTH);

    this.el = document.createElement('div');
    this.el.className =
      'absolute left-0 top-[var(--fluidcad-chrome-top,104px)] bottom-0 z-[115] ' +
      'flex flex-col bg-base-100 border-r border-base-content/10 hidden';
    this.el.style.width = `${this.width}px`;

    this.editorHost = document.createElement('div');
    this.editorHost.className = 'flex-1 min-h-0';
    this.el.appendChild(this.editorHost);

    this.el.appendChild(this.buildResizeHandle());
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
      this.editor = monaco.editor.create(this.editorHost, {
        ...EDITOR_OPTIONS,
        overflowWidgetsDomNode: overflowWidgetsHost(),
      });
    }
    return this.editor;
  }

  getEditor(): monaco.editor.IStandaloneCodeEditor | null {
    return this.editor;
  }

  isOpen(): boolean {
    return this.open;
  }

  getWidth(): number {
    return this.width;
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
      this.applyWidth(true);
      // Monaco measures its container on create; if that happened while the
      // pane was still `hidden` it measured zero.
      this.editor?.layout();
      this.editor?.focus();
    } else {
      this.setWidthVariable(0, true);
    }
    this.options.onOpenChange?.(open);
  }

  setWidth(width: number): void {
    this.width = clampWidth(width);
    this.el.style.width = `${this.width}px`;
    if (this.open) {
      this.applyWidth(false);
    }
    this.options.onWidthChange?.(this.width);
  }

  /**
   * On a phone there isn't enough width to split, so the pane covers the scene
   * instead — the one documented exception to "pushes, never overlays".
   */
  private isMobile(): boolean {
    return window.innerWidth < MOBILE_BREAKPOINT;
  }

  private applyWidth(animate: boolean): void {
    if (this.isMobile()) {
      this.el.style.width = '100%';
      this.setWidthVariable(0, animate);
      return;
    }
    this.el.style.width = `${this.width}px`;
    this.setWidthVariable(this.width, animate);
  }

  /**
   * The whole geometry mechanism, in one line. Animated on open/close and
   * instant while dragging, because a transition mid-drag lags the pointer.
   */
  private setWidthVariable(value: number, animate: boolean): void {
    const root = document.documentElement;
    root.classList.toggle('fluidcad-editor-animating', animate);
    root.style.setProperty(WIDTH_VARIABLE, `${value}px`);
    if (animate) {
      window.setTimeout(() => root.classList.remove('fluidcad-editor-animating'), 220);
    }
  }

  private buildResizeHandle(): HTMLElement {
    const handle = document.createElement('div');
    handle.className =
      'absolute top-0 right-0 bottom-0 w-1 cursor-col-resize ' +
      'hover:bg-primary/40 active:bg-primary/60 transition-colors';
    handle.title = 'Drag to resize';

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = this.width;

      const onMove = (move: PointerEvent) => {
        this.setWidth(startWidth + (move.clientX - startX));
      };
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

function clampWidth(width: number): number {
  const max = Math.max(MIN_WIDTH, window.innerWidth - MIN_SCENE_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}
