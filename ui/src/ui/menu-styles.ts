/**
 * The one look every popup menu in the viewer shares — the tab context menu,
 * a start card's and the configuration band's ⋮ menus, the unit chip's
 * dropup, the section and connector pick menus. Kept as class strings, not
 * a component: each menu positions itself differently and that is the only
 * thing that differs.
 *
 * The surface is solid `bg-base-100`, the popups' surface everywhere else
 * (the viewport's pick menu, an expression field's suggestions, the
 * dialogs), never the docked chrome's translucent `panel-bg`: a menu opens
 * over panels full of text and fields, and their labels must not read
 * through its rows.
 */
// z-[1000]: a transient menu must clear the docked feature panels (z-[999]);
// toasts stay above it at 1003.
export const MENU_CLASS =
  'absolute z-[1000] min-w-[160px] p-1 bg-base-100 border border-base-content/10 rounded-md ' +
  'shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

export const MENU_ROW_CLASS =
  'flex items-center gap-2.5 w-full px-2 py-1.5 rounded text-left text-[13px] ' +
  'text-base-content/80 cursor-pointer hover:bg-base-content/[0.08] ' +
  'focus-visible:outline-none focus-visible:bg-base-content/[0.08]';

/** A non-interactive caption row above a menu's items. */
export const MENU_HEADER_CLASS =
  'px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide text-base-content/40 select-none whitespace-nowrap';
