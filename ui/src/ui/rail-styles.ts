/**
 * The class string both left rails wear — the part scene's feature tree
 * (TimelinePanel) and the assembly scene's parts/joints column (PartsPanel).
 * They occupy the same slot and are swapped as the scene kind changes, so
 * their geometry lives in one place.
 *
 * Five custom properties place it, all defaulting to the desktop app's own
 * layout so an unset host gets today's behaviour:
 *
 * - `--fluidcad-panel-left`    the scene's left gutter (styles.css folds the
 *   panel rail, the code editor's width and the project Parameters column
 *   into it)
 * - `--fluidcad-panel-gap`     the inset from that gutter and the chrome
 * - `--fluidcad-chrome-top`    the host chrome above the scene (toolbars)
 * - `--fluidcad-panel-inset-top` / `--fluidcad-panel-inset-bottom`
 *   room an embedding host has claimed inside the viewport for its own
 *   overlays. The scene still fills the frame — only the floating panels
 *   step aside — so a page can set copy over the top of the viewport, or
 *   controls along its bottom, without the rail running underneath.
 */
export const RAIL_PANEL_CLASS =
  'absolute left-[calc(var(--fluidcad-panel-left,0px)+var(--fluidcad-panel-gap))] ' +
  'top-[calc(var(--fluidcad-chrome-top,104px)+var(--fluidcad-panel-inset-top,0px)+var(--fluidcad-panel-gap))] ' +
  'bottom-[calc(var(--fluidcad-panel-inset-bottom,0px)+1.5rem)] ' +
  'w-[220px] z-[99] flex flex-col gap-1 select-none hidden';

/** How wide the project Parameters column is, in px — published through {@link GLOBAL_PANEL_WIDTH_VARIABLE} while open. */
export const GLOBAL_PANEL_WIDTH = 260;

/**
 * The width the project Parameters column takes off the left while open:
 * styles.css adds it to `--fluidcad-panel-left` (and so the scene's left
 * edge), which is what shifts the scene and the feature tree / parts column
 * right by exactly the column. Unset (or 0px) while closed, so a host that
 * never mounts it is untouched.
 */
export const GLOBAL_PANEL_WIDTH_VARIABLE = '--fluidcad-global-params-width';

/**
 * The project Parameters column: chrome like the editor pane, not a floating
 * column like the rails above — flush against `--fluidcad-dock-left` (the
 * rail plus the editor pane, WITHOUT its own width) and the toolbar, down to
 * the window's bottom, on the editor's opaque base surface with the same
 * right-hand border. Wider than the rails: its rows carry a label, a control
 * and an identifier.
 */
export const GLOBAL_PANEL_CLASS =
  'absolute left-[var(--fluidcad-dock-left,0px)] top-[var(--fluidcad-chrome-top,104px)] bottom-0 ' +
  'w-[260px] z-[99] flex flex-col select-none hidden ' +
  'bg-base-100 border-r border-base-content/10';
