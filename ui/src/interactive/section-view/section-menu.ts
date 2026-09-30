import { ICON_CHECK, ICON_PLUS } from '../../ui/icons';
import { MENU_CLASS, MENU_HEADER_CLASS, MENU_ROW_CLASS } from '../../ui/menu-styles';

export type SectionMenuEntry = {
  key: string;
  label: string;
  /** Why the view cannot be shown (its plane did not build); disables the row. */
  disabledReason?: string | null;
};

export type SectionMenuOptions = {
  entries: SectionMenuEntry[];
  /** The active view's key; null when the scene shows uncut. */
  activeKey: string | null;
  /** A row was picked: a view's key, or null for "None". */
  onSelect(key: string | null): void;
  /** "New section view…" was picked. */
  onNew(): void;
  /** Whether a new view can be written (an editor-backed host with a file open). */
  canCreate: boolean;
};

/** Gap between the anchor's left edge and the menu's right edge. */
const ANCHOR_GAP = 6;
const EDGE_MARGIN = 8;

let open: { el: HTMLElement; close(): void } | null = null;

export function closeSectionMenu(): void {
  open?.close();
}

export function isSectionMenuOpen(): boolean {
  return open !== null;
}

/**
 * The section-views menu, opening to the LEFT of the viewport button it
 * hangs off (the button sits at the right edge, under the view gizmo),
 * top-aligned with it. Radio rows for "None" and every saved view, then
 * the create row. Same mounting and dismissal rules as the dropup menu:
 * in `host`, one at a time, closed on an outside press, Escape, or a pick;
 * arrow keys move between rows.
 */
export function showSectionMenu(host: HTMLElement, anchor: HTMLElement, options: SectionMenuOptions): HTMLElement {
  closeSectionMenu();
  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  menu.dataset.role = 'section-menu';
  const header = document.createElement('div');
  header.className = MENU_HEADER_CLASS;
  header.textContent = 'Section views';
  menu.appendChild(header);

  const rows: HTMLButtonElement[] = [];
  const addRadio = (label: string, current: boolean, onPick: () => void, disabledReason: string | null = null): void => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = MENU_ROW_CLASS + (disabledReason ? ' opacity-50 cursor-not-allowed' : '');
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', current ? 'true' : 'false');
    if (disabledReason) {
      row.disabled = true;
      row.title = disabledReason;
    }
    row.innerHTML =
      `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5 ${current ? '' : 'invisible'}">${ICON_CHECK}</span>`;
    const text = document.createElement('span');
    text.className = 'truncate max-w-[220px]';
    text.textContent = label;
    row.appendChild(text);
    row.addEventListener('click', () => {
      close();
      onPick();
    });
    rows.push(row);
    menu.appendChild(row);
  };

  addRadio('None', options.activeKey === null, () => options.onSelect(null));
  for (const entry of options.entries) {
    addRadio(entry.label, options.activeKey === entry.key, () => options.onSelect(entry.key), entry.disabledReason ?? null);
  }

  if (options.canCreate) {
    const divider = document.createElement('div');
    divider.className = 'my-1 border-t border-base-content/10';
    menu.appendChild(divider);
    const create = document.createElement('button');
    create.type = 'button';
    create.className = MENU_ROW_CLASS;
    create.setAttribute('role', 'menuitem');
    create.dataset.role = 'section-new';
    create.innerHTML = `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_PLUS}</span>`;
    const text = document.createElement('span');
    text.textContent = 'New section view…';
    create.appendChild(text);
    create.addEventListener('click', () => {
      close();
      options.onNew();
    });
    rows.push(create);
    menu.appendChild(create);
  }

  // Top-right of the menu sits at the anchor's top-left corner.
  const hostRect = host.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  menu.style.top = `${anchorRect.top - hostRect.top}px`;
  menu.style.right = `${hostRect.right - anchorRect.left + ANCHOR_GAP}px`;
  host.appendChild(menu);

  // A tall list near the bottom would run out of the host.
  const rect = menu.getBoundingClientRect();
  const overflowY = rect.bottom - (hostRect.bottom - EDGE_MARGIN);
  if (overflowY > 0) {
    menu.style.top = `${Math.max(EDGE_MARGIN, anchorRect.top - hostRect.top - overflowY)}px`;
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
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const enabled = rows.filter(r => !r.disabled);
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(at + step + enabled.length) % enabled.length]?.focus();
      event.preventDefault();
    }
  };
  let listening = false;
  setTimeout(() => {
    if (open?.el === menu) {
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown, true);
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
      document.removeEventListener('keydown', onKeyDown, true);
    }
  };
  open = { el: menu, close };
  anchor.setAttribute('aria-expanded', 'true');
  (rows.find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus();
  return menu;
}
