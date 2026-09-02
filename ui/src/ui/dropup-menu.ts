import { ICON_CHECK } from './icons';
import { MENU_CLASS, MENU_HEADER_CLASS, MENU_ROW_CLASS } from './menu-styles';

export type DropupMenuItem = {
  label: string;
  /** Hover tooltip — the long form of a terse label. */
  title?: string;
  /** Marked with a check and announced as the current choice. */
  current?: boolean;
  onSelect(): void;
};

export type DropupMenuOptions = {
  /** Caption above the items — what the choice applies to. */
  header?: string;
  items: DropupMenuItem[];
};

/** Gap between the anchor's top edge and the menu's bottom edge. */
const ANCHOR_GAP = 6;
/** Keep the menu clear of the host's left edge by at least this much. */
const EDGE_MARGIN = 8;

let open: { el: HTMLElement; close(): void } | null = null;

/** Dismiss whichever dropup is showing, if any. */
export function closeDropupMenu(): void {
  open?.close();
}

/**
 * A small menu that opens *upward* from a control sitting at the bottom of
 * the viewer (the status-row chips), right-aligned to it. Same look and
 * dismissal rules as the tab context menu (`editor/tab-menu.ts`): mounted
 * in `host` — the positioning context every overlay shares — one at a
 * time, closed on an outside press, Escape, or a pick. Arrow keys move
 * between rows; focus starts on the current item so Enter re-affirms it.
 */
export function showDropupMenu(host: HTMLElement, anchor: HTMLElement, options: DropupMenuOptions): HTMLElement {
  closeDropupMenu();
  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  if (options.header) {
    const header = document.createElement('div');
    header.className = MENU_HEADER_CLASS;
    header.textContent = options.header;
    menu.appendChild(header);
  }
  const rows: HTMLButtonElement[] = [];
  for (const item of options.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = MENU_ROW_CLASS;
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', item.current ? 'true' : 'false');
    if (item.title) {
      row.title = item.title;
    }
    row.innerHTML =
      `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5 ${item.current ? '' : 'invisible'}">${ICON_CHECK}</span>`;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    row.addEventListener('click', () => {
      close();
      item.onSelect();
    });
    rows.push(row);
    menu.appendChild(row);
  }

  // Bottom-right of the menu sits above the anchor's top-right corner.
  const hostRect = host.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  menu.style.bottom = `${hostRect.bottom - anchorRect.top + ANCHOR_GAP}px`;
  menu.style.right = `${hostRect.right - anchorRect.right}px`;
  host.appendChild(menu);

  // A chip near the left edge would push the menu out of the host.
  const rect = menu.getBoundingClientRect();
  const overflowX = hostRect.left + EDGE_MARGIN - rect.left;
  if (overflowX > 0) {
    menu.style.right = `${hostRect.right - anchorRect.right - overflowX}px`;
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
      close();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
      anchor.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[(at + step + rows.length) % rows.length];
      next?.focus();
      event.preventDefault();
    }
  };
  // Registered after the opening event's cycle, so the click that opened
  // the menu can't also be the press that dismisses it.
  let listening = false;
  setTimeout(() => {
    if (open?.el === menu) {
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      listening = true;
    }
  }, 0);

  const close = () => {
    if (open?.el !== menu) {
      return;
    }
    open = null;
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (listening) {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  open = { el: menu, close };
  anchor.setAttribute('aria-expanded', 'true');
  (rows.find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus();
  return menu;
}
