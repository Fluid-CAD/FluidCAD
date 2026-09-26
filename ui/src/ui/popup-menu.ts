/**
 * A small popup menu: a file tab's right-click menu, a start-screen card's ⋯
 * menu. Mounted in a host that is the page's positioning context (the viewer
 * mounts it in `#fluidcad-viewer`, which every overlay shares) rather than in
 * the element that opened it: a tab strip's scroller or a card's rounded box
 * clips its overflow, and a menu hanging off either would be cut short.
 */

import { MENU_CLASS as MENU, MENU_ROW_CLASS as ROW } from './menu-styles';

export type PopupMenuItem = {
  icon: string;
  label: string;
  onSelect(): void;
  /** Tailwind classes for the row, e.g. `text-error` for a destructive item. */
  className?: string;
  /** Shown but not pickable; `title` then says why. */
  disabled?: boolean;
  title?: string;
};

export type PopupMenuOptions = {
  /** Which edge of the menu sits at the position: its left (a right-click) or its right (a ⋯ button at a card's corner). */
  align?: 'start' | 'end';
  /** Put keyboard focus on the first row, for a menu opened from a button. */
  focusFirst?: boolean;
};

/** Keep the menu clear of the viewport's edges by at least this much. */
const EDGE_MARGIN = 8;

let open: { el: HTMLElement; close(): void } | null = null;

/** Dismiss whichever popup menu is showing, if any. */
export function closePopupMenu(): void {
  open?.close();
}

/** True while a popup menu is showing. */
export function isPopupMenuOpen(): boolean {
  return open !== null;
}

/**
 * Show `items` at a viewport position. One menu at a time: opening another
 * closes the first. Closes on a pointer press anywhere outside it, on Escape,
 * and after an item is picked.
 */
export function showPopupMenu(
  host: HTMLElement,
  position: { clientX: number; clientY: number },
  items: PopupMenuItem[],
  options: PopupMenuOptions = {},
): HTMLElement {
  closePopupMenu();
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
    if (item.title) {
      row.title = item.title;
    }
    if (item.disabled) {
      row.disabled = true;
      row.classList.add('opacity-40', 'pointer-events-none');
    }
    row.addEventListener('click', () => {
      close();
      item.onSelect();
    });
    menu.appendChild(row);
  }

  const hostRect = host.getBoundingClientRect();
  let left = position.clientX - hostRect.left;
  menu.style.left = `${left}px`;
  menu.style.top = `${position.clientY - hostRect.top}px`;
  host.appendChild(menu);

  if (options.align === 'end') {
    // Right edge on the position, but never past the window's left edge.
    left = Math.max(EDGE_MARGIN - hostRect.left, left - menu.getBoundingClientRect().width);
    menu.style.left = `${left}px`;
  }

  // Pull the menu back inside the window if the click was near an edge.
  const rect = menu.getBoundingClientRect();
  const overflowX = rect.right - (window.innerWidth - EDGE_MARGIN);
  if (overflowX > 0) {
    menu.style.left = `${left - overflowX}px`;
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
  if (options.focusFirst) {
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  return menu;
}
