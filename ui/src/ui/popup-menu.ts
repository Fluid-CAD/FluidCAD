/**
 * A small popup menu: a file tab's right-click menu, a start-screen card's ⋯
 * menu. Mounted in a host that is the page's positioning context (the viewer
 * mounts it in `#fluidcad-viewer`, which every overlay shares) rather than in
 * the element that opened it: a tab strip's scroller or a card's rounded box
 * clips its overflow, and a menu hanging off either would be cut short.
 */

import { MENU_CLASS as MENU, MENU_ROW_CLASS as ROW } from './menu-styles';
import { ICON_SUBMENU } from './icons';

export type PopupMenuItem = {
  icon: string;
  label: string;
  /** What picking the row does. Absent on a row with a {@link submenu}, which opens that instead. */
  onSelect?(): void;
  /** Rows that open beside this one when it is hovered or clicked — `Close other tabs ▸` and its variants. */
  submenu?: PopupMenuItem[];
  /** A rule above the row, setting it apart from the ones before — a destructive item from the rest. */
  separated?: boolean;
  /** Tailwind classes for the row, e.g. `text-error` for a destructive item. */
  className?: string;
  /** Shown but not pickable; `title` then says why. */
  disabled?: boolean;
  title?: string;
  /** With {@link PopupMenuOptions.search}: more text the filter matches besides the label (a model's id). */
  keywords?: string;
  /** With {@link PopupMenuOptions.search}: kept under the list whatever is typed ("Other model…"). */
  pinned?: boolean;
  /** With {@link PopupMenuOptions.search}: the row the list scrolls to when it opens (the current choice). */
  selected?: boolean;
};

export type PopupMenuOptions = {
  /** Which edge of the menu sits at the position: its left (a right-click) or its right (a ⋯ button at a card's corner). */
  align?: 'start' | 'end';
  /** Put keyboard focus on the first row, for a menu opened from a button. */
  focusFirst?: boolean;
  /**
   * `above`: the menu's bottom edge sits at the position (a dropup, for a
   * button near the window's bottom such as the Agent panel's composer chips).
   */
  placement?: 'below' | 'above';
  /**
   * A filter field above the rows, and the rows in a list that scrolls: for
   * a long menu (the Agent panel's model chip on OpenRouter). The field takes
   * the focus; every word typed must appear in a row's label or keywords.
   * Rows with submenus are not supported here.
   */
  search?: { placeholder: string; empty?: string };
};

/** A searchable menu is never taller than this, nor than the room the window leaves. */
const SEARCH_MAX_HEIGHT = 420;

/** Keep the menu clear of the viewport's edges by at least this much. */
const EDGE_MARGIN = 8;

/** A menu's `p-1` plus its 1px border: how far a submenu's first row sits below the submenu's top. */
const SUBMENU_INSET = 5;

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
  // `close` is assigned below; a row only calls it once the menu is showing.
  const search = options.search ? fillSearchMenu(menu, items, options.search, () => close()) : null;
  if (!search) {
    fillMenu(menu, items, () => close());
  }
  if (search) {
    // Room above the chip (a dropup) or below the click, whichever way it opens.
    const room = options.placement === 'above' ? position.clientY - EDGE_MARGIN : window.innerHeight - position.clientY - EDGE_MARGIN;
    menu.style.maxHeight = `${Math.max(160, Math.min(SEARCH_MAX_HEIGHT, room))}px`;
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

  if (options.placement === 'above') {
    const height = menu.getBoundingClientRect().height;
    menu.style.top = `${Math.max(EDGE_MARGIN - hostRect.top, position.clientY - hostRect.top - height)}px`;
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
  if (search) {
    // The height it opened with stays while filtering: the field does not move under the typing.
    menu.style.height = `${menu.getBoundingClientRect().height}px`;
    search.input.focus();
    search.list.querySelector<HTMLElement>('[data-selected]')?.scrollIntoView?.({ block: 'nearest' });
  } else if (options.focusFirst) {
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  return menu;
}

/**
 * A searchable menu's parts: the filter field, the scrolling list of the
 * rows it filters, then the pinned rows. Arrow keys move between the field
 * and the rows shown; Enter in the field picks the first row shown; typing
 * on a row goes on in the field.
 */
function fillSearchMenu(
  menu: HTMLElement,
  items: PopupMenuItem[],
  options: { placeholder: string; empty?: string },
  close: () => void,
): { input: HTMLInputElement; list: HTMLElement } {
  menu.classList.add('flex', 'flex-col', 'w-[300px]');
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.ref = 'menu-search';
  input.className = 'input input-xs input-bordered w-full shrink-0 mb-1 text-[13px]';
  input.placeholder = options.placeholder;
  input.setAttribute('aria-label', options.placeholder);
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('div');
  list.dataset.ref = 'menu-list';
  list.className = 'flex-1 min-h-0 overflow-y-auto';
  const empty = document.createElement('div');
  empty.dataset.ref = 'menu-empty';
  empty.className = 'hidden px-2 py-1.5 text-[12px] text-base-content/50';
  empty.textContent = options.empty ?? 'No matches';
  const footer = document.createElement('div');
  footer.className = 'shrink-0';

  const rows: { row: HTMLButtonElement; text: string }[] = [];
  for (const item of items) {
    const row = buildRow(item);
    // One line per row, the whole name on hover.
    row.querySelector('span:last-child')?.classList.add('truncate', 'min-w-0');
    row.title ||= item.label;
    row.addEventListener('click', () => {
      close();
      item.onSelect?.();
    });
    if (item.pinned) {
      if (item.separated) {
        const rule = document.createElement('div');
        rule.className = 'my-1 border-t border-base-content/10';
        rule.setAttribute('role', 'separator');
        footer.appendChild(rule);
      }
      footer.appendChild(row);
      continue;
    }
    if (item.selected) {
      row.dataset.selected = '';
    }
    rows.push({ row, text: `${item.label} ${item.keywords ?? ''}`.toLowerCase() });
    list.appendChild(row);
  }
  list.appendChild(empty);

  const shown = () => rows.filter((r) => !r.row.classList.contains('hidden')).map((r) => r.row);
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const { row, text } of rows) {
      const match = words.every((w) => text.includes(w));
      row.classList.toggle('hidden', !match);
      any ||= match;
    }
    empty.classList.toggle('hidden', any || rows.length === 0);
    list.scrollTop = 0;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      shown()[0]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      shown()[0]?.click();
    }
  });
  list.addEventListener('keydown', (event) => {
    const visible = shown();
    const at = visible.indexOf(event.target as HTMLButtonElement);
    if (at < 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      visible[Math.min(visible.length - 1, at + 1)].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      (at === 0 ? input : visible[at - 1]).focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on a row filters on.
      event.preventDefault();
      input.focus();
      input.value += event.key;
      input.dispatchEvent(new Event('input'));
    }
  });
  menu.append(input, list);
  if (footer.childElementCount > 0) {
    menu.appendChild(footer);
  }
  return { input, list };
}

/**
 * Add `items`' rows to `menu`. A row with a submenu opens it beside itself on
 * hover, click or ArrowRight, and another row's hover closes it again. The
 * submenu is mounted inside `menu`, so a press in it isn't a press outside,
 * and it goes when the menu does.
 */
function fillMenu(menu: HTMLElement, items: PopupMenuItem[], close: () => void): void {
  let expanded: { row: HTMLElement; submenu: HTMLElement } | null = null;
  const collapse = () => {
    if (expanded) {
      expanded.row.setAttribute('aria-expanded', 'false');
      expanded.submenu.remove();
      expanded = null;
    }
  };

  for (const item of items) {
    if (item.separated) {
      const rule = document.createElement('div');
      rule.className = 'my-1 border-t border-base-content/10';
      rule.setAttribute('role', 'separator');
      menu.appendChild(rule);
    }
    const row = buildRow(item);
    menu.appendChild(row);

    const children = item.submenu;
    if (!children) {
      row.addEventListener('pointerenter', collapse);
      row.addEventListener('click', () => {
        close();
        item.onSelect?.();
      });
      continue;
    }
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-expanded', 'false');
    const expand = (): HTMLElement => {
      if (expanded?.row === row) {
        return expanded.submenu;
      }
      collapse();
      const submenu = document.createElement('div');
      submenu.className = MENU;
      submenu.setAttribute('role', 'menu');
      fillMenu(submenu, children, close);
      submenu.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          collapse();
          row.focus();
        }
      });
      menu.appendChild(submenu);
      placeSubmenu(submenu, row);
      row.setAttribute('aria-expanded', 'true');
      expanded = { row, submenu };
      return submenu;
    };
    row.addEventListener('pointerenter', () => expand());
    row.addEventListener('click', () => expand());
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        expand().querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      }
    });
  }
}

function buildRow(item: PopupMenuItem): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `${ROW} ${item.className ?? ''}`;
  row.setAttribute('role', 'menuitem');
  row.innerHTML = `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${item.icon}</span>`;
  const label = document.createElement('span');
  label.textContent = item.label;
  row.appendChild(label);
  if (item.submenu) {
    // Stays lit while its submenu is showing, so the pointer's trip into it
    // doesn't leave the row looking unrelated.
    row.classList.add('aria-expanded:bg-base-content/[0.08]');
    const chevron = document.createElement('span');
    chevron.className = 'ml-auto shrink-0 text-base-content/50 [&>svg]:size-3.5';
    chevron.innerHTML = ICON_SUBMENU;
    row.appendChild(chevron);
  }
  if (item.title) {
    row.title = item.title;
  }
  if (item.disabled) {
    row.disabled = true;
    row.classList.add('opacity-40', 'pointer-events-none');
  }
  return row;
}

/**
 * Beside `row`, its first row level with it — to the right of the menu, or
 * to the left when the window has no room there — and pulled up off the
 * window's bottom edge.
 */
function placeSubmenu(submenu: HTMLElement, row: HTMLElement): void {
  const top = row.offsetTop - SUBMENU_INSET;
  submenu.style.left = '100%';
  submenu.style.top = `${top}px`;
  const rect = submenu.getBoundingClientRect();
  if (rect.right > window.innerWidth - EDGE_MARGIN) {
    submenu.style.left = 'auto';
    submenu.style.right = '100%';
  }
  const overflowY = rect.bottom - (window.innerHeight - EDGE_MARGIN);
  if (overflowY > 0) {
    submenu.style.top = `${top - overflowY}px`;
  }
}
