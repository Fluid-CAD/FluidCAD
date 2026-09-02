/**
 * The right-click menu on a file tab. Mounted in `#fluidcad-viewer` — the
 * positioning context every overlay shares — rather than in the tab: the tab
 * strip's scroller clips its overflow, and a menu hanging off the last tab
 * would be cut short.
 */

import { MENU_CLASS as MENU, MENU_ROW_CLASS as ROW } from '../ui/menu-styles';

export type TabMenuItem = {
  icon: string;
  label: string;
  onSelect(): void;
  /** Tailwind classes for the row, e.g. `text-error` for a destructive item. */
  className?: string;
};

/** Keep the menu clear of the viewport's edges by at least this much. */
const EDGE_MARGIN = 8;

let open: { el: HTMLElement; close(): void } | null = null;

/** Dismiss whichever tab menu is showing, if any. */
export function closeTabMenu(): void {
  open?.close();
}

/**
 * Show `items` at a viewport position. One menu at a time: opening another
 * closes the first. Closes on a pointer press anywhere outside it, on Escape,
 * and after an item is picked.
 */
export function showTabMenu(host: HTMLElement, position: { clientX: number; clientY: number }, items: TabMenuItem[]): HTMLElement {
  closeTabMenu();
  const menu = document.createElement('div');
  menu.className = MENU;
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `${ROW} ${item.className ?? ''}`;
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${item.icon}</span>`;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    row.addEventListener('click', () => {
      close();
      item.onSelect();
    });
    menu.appendChild(row);
  }

  const hostRect = host.getBoundingClientRect();
  menu.style.left = `${position.clientX - hostRect.left}px`;
  menu.style.top = `${position.clientY - hostRect.top}px`;
  host.appendChild(menu);

  // Pull the menu back inside the window if the click was near an edge.
  const rect = menu.getBoundingClientRect();
  const overflowX = rect.right - (window.innerWidth - EDGE_MARGIN);
  if (overflowX > 0) {
    menu.style.left = `${position.clientX - hostRect.left - overflowX}px`;
  }
  const overflowY = rect.bottom - (window.innerHeight - EDGE_MARGIN);
  if (overflowY > 0) {
    menu.style.top = `${position.clientY - hostRect.top - overflowY}px`;
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
    }
  };
  // Registered after the opening event's cycle, so the right-click that
  // opened the menu can't also be the press that dismisses it.
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
    if (listening) {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  open = { el: menu, close };
  return menu;
}
