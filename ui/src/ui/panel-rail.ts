import { ICON_CODE, ICON_LIST_TREE } from './icons';

/**
 * The gutter the rail owns down the left edge, published so everything to its
 * right can clear it: the editor pane docks at exactly this offset, and
 * `--fluidcad-panel-left` (styles.css) folds it together with the pane's own
 * width for the docked panel column. A host that never mounts a rail leaves it
 * unset, which resolves to 0px.
 */
const RAIL_WIDTH_VARIABLE = '--fluidcad-rail-width';
const RAIL_WIDTH = '48px';

/**
 * Below this the rail floats instead of docking — see the matching
 * `--fluidcad-scene-left` override in styles.css, which is what hands the
 * width back to the scene. Kept in one place on each side because a mismatch
 * would leave the bar painted over a scene that never made room for it.
 */
const FLOAT_QUERY = '(width < 40rem)';

/** Docked: real chrome down the left edge, flush against the editor pane. */
const BAR_RAIL =
  'absolute left-0 top-[var(--fluidcad-chrome-top,104px)] bottom-0 w-12 z-[116] ' +
  'flex flex-col items-center gap-1 py-2 panel-bg border-r border-base-content/10 ' +
  'select-none';
/**
 * Floating: no bar behind the buttons at all, so the element must not swallow
 * the scene's pointer events either — it hugs its buttons rather than running
 * to the bottom, and hands what it does cover back through the wraps.
 */
const FLOAT_RAIL =
  'absolute left-3 top-[calc(var(--fluidcad-chrome-top,104px)+12px)] z-[116] ' +
  'flex flex-col items-start gap-2 select-none pointer-events-none';

const BAR_BTN = 'btn btn-ghost btn-square btn-sm text-base-content/60 [&>svg]:size-5';
/** A toggle whose surface is on screen — same latch the toolbar's armed tools use. */
const BAR_BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm [&>svg]:size-5';
/**
 * With no bar to sit on, each floating button carries its own surface — the
 * same circle, translucent fill and hairline as the scene-settings column on
 * the other side of the viewport.
 */
const FLOAT_BTN =
  'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60 [&>svg]:size-5';
const FLOAT_BTN_ACTIVE = 'btn btn-soft btn-primary btn-circle btn-sm [&>svg]:size-5';

interface RailButton {
  /** The tooltip host — daisyUI renders its `data-tip`. */
  wrap: HTMLSpanElement;
  button: HTMLButtonElement;
}

export interface PanelRailHandlers {
  /** Toggle the docked panel column — the feature tree, or the assembly's parts. */
  onToggleTree: () => void;
  /** Whether that column is on screen, for the button's latch. */
  isTreeVisible: () => boolean;
  /** Its tooltip; the assembly rail names the column "Parts". */
  treeLabel?: () => string;
  /**
   * Toggle the code-editor pane. Absent on a viewport-only host, which is
   * what removes the button.
   */
  onToggleEditor?: () => void;
  isEditorOpen?: () => boolean;
  /** The editor button's tooltip — a read-only host says "Code" rather than "Code editor". */
  editorLabel?: string;
}

/**
 * The panel rail: a full-height vertical bar pinned to the window's left edge,
 * holding one latch button per surface it opens — the feature tree (timeline)
 * on top, the code-editor pane beneath it. It replaces the top bar's hamburger menu, which hid both
 * toggles behind a click and gave no sign of what was open.
 *
 * It is chrome, not an overlay: it takes width off the left the way the top
 * bars take height off the top, and everything else on that side — the editor
 * pane first, then the scene and its panels — starts where the rail ends. That
 * is what keeps it in place while the pane it opens slides in beside it, and
 * what keeps the tree reachable while the tree is hidden.
 *
 * Under {@link FLOAT_QUERY} that trade stops paying: a fixed 48px of chrome is
 * a big bite out of a narrow window. The bar drops away there and the buttons
 * float over the scene as circles carrying their own surface — the same shape
 * the scene-settings column uses on the right — and the scene takes the width
 * back. The buttons keep their gutter either way, so nothing else moves.
 *
 * Latch state is polled, never stored. The pane and the panels are also
 * toggled from the keyboard (Ctrl+B), the desktop menu and their own code, so
 * {@link sync} re-reads the handlers instead of tracking a copy that drifts.
 */
export class PanelRail {
  private readonly el: HTMLDivElement;
  private readonly editorBtn: RailButton | null;
  private readonly treeBtn: RailButton;
  private readonly floatQuery: MediaQueryList | null;

  constructor(container: HTMLElement, private readonly handlers: PanelRailHandlers) {
    this.el = document.createElement('div');
    // Same reason the Navbar does it: a clicked button that keeps focus is
    // re-matched as :focus-visible when the window is re-activated, which
    // drops daisyUI's soft styling off a latched toggle.
    this.el.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element && event.target.closest('button')) {
        event.preventDefault();
      }
    });
    container.appendChild(this.el);
    document.documentElement.style.setProperty(RAIL_WIDTH_VARIABLE, RAIL_WIDTH);

    // Tree (timeline) first, editor beneath it.
    this.treeBtn = this.addButton(ICON_LIST_TREE, handlers.onToggleTree);
    this.editorBtn = handlers.onToggleEditor
      ? this.addButton(ICON_CODE, handlers.onToggleEditor)
      : null;

    this.floatQuery = window.matchMedia?.(FLOAT_QUERY) ?? null;
    this.floatQuery?.addEventListener('change', () => this.applyMode());
    this.applyMode();
  }

  /** Whether the window is narrow enough that the bar floats. */
  private get floating(): boolean {
    return this.floatQuery?.matches === true;
  }

  /** Repaint for the current mode — the shell, then the buttons inside it. */
  private applyMode(): void {
    // The z sits one above the editor pane so a tooltip, which opens rightward
    // across it, isn't painted under it — and below the bars, which own the
    // band overhead.
    this.el.className = this.floating ? FLOAT_RAIL : BAR_RAIL;
    this.sync();
  }

  /** Re-read the handlers and repaint the latches. */
  sync(): void {
    if (this.editorBtn) {
      this.setState(
        this.editorBtn,
        this.handlers.isEditorOpen?.() === true,
        this.handlers.editorLabel ?? 'Code editor',
      );
    }
    this.setState(
      this.treeBtn,
      this.handlers.isTreeVisible(),
      this.handlers.treeLabel?.() ?? 'Feature tree',
    );
  }

  private addButton(icon: string, onToggle: () => void): RailButton {
    const button = document.createElement('button');
    button.innerHTML = icon;
    button.addEventListener('click', () => {
      onToggle();
      // Whatever the handler did synchronously shows immediately; a toggle it
      // could only queue — an editor pane still being fetched — repaints when
      // the surface reports its open state.
      this.sync();
    });

    const wrap = document.createElement('span');
    // pointer-events-auto: the floating shell disowns them so the scene stays
    // draggable between the circles.
    wrap.className = 'tooltip tooltip-right pointer-events-auto';
    wrap.appendChild(button);
    this.el.appendChild(wrap);
    return { wrap, button };
  }

  private setState(entry: RailButton, active: boolean, label: string): void {
    entry.button.className = this.floating
      ? (active ? FLOAT_BTN_ACTIVE : FLOAT_BTN)
      : (active ? BAR_BTN_ACTIVE : BAR_BTN);
    entry.button.setAttribute('aria-label', label);
    entry.button.setAttribute('aria-pressed', String(active));
    entry.wrap.dataset.tip = label;
  }
}
