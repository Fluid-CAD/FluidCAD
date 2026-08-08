/**
 * Class strings shared by every button that rides the {@link Navbar}: the
 * create/modify feature buttons, the sketch tools, and the Import button.
 *
 * They are deliberately tight. The bar packs close to twenty tools into the
 * window width, so a button claims only as much room as its caption needs and
 * the breathing space is carried by the dividers the navbar draws between
 * groups rather than by padding on every button. Past that point the bar
 * scrolls — see `ToolbarScroller`.
 */
const TOOLBAR_BTN_SHAPE = 'btn btn-sm h-auto flex-col gap-0.5 px-1.5 py-1 shrink-0';

/** An idle toolbar button. */
export const TOOLBAR_BTN_BASE = `${TOOLBAR_BTN_SHAPE} btn-ghost text-base-content/60`;

/** A toolbar button whose tool is armed. */
export const TOOLBAR_BTN_ACTIVE = `${TOOLBAR_BTN_SHAPE} btn-soft btn-primary`;

/**
 * A toolbar button whose *mode* is latched on (Guide). Louder than the armed
 * state — a solid primary ring on top of the soft fill — so a sticky mode
 * that recolors everything drawn next reads differently from an armed tool.
 */
export const TOOLBAR_BTN_ACTIVE_STRONG = `${TOOLBAR_BTN_SHAPE} btn-soft btn-primary ring-2 ring-primary`;

/** The small muted caption under a toolbar icon. */
export const TOOLBAR_BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

/** The icon above the caption. */
export const TOOLBAR_BTN_ICON = 'w-7 h-7 object-contain shrink-0';
