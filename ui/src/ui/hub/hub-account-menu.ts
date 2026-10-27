import { MENU_CLASS, MENU_ROW_CLASS } from '../menu-styles';
import { HubIcons } from './hub-icons';

export type HubAccountMenuItem = {
  /** `data-ref` of the row. */
  ref: string;
  icon: string;
  label: string;
  title?: string;
  onSelect(): void;
};

/**
 * The signed-in account's dropdown in the Hub panel's header (H11 follow-up
 * 3, the user's request of 2026-10-12): your own handle opens it rather
 * than listing your packages, and it holds Sign out.
 *
 * It looks like the app's other menus (`menu-styles`) and closes like the
 * panel's other dropdowns: on a press outside it, on Escape (taken in the
 * capture phase and stopped there, so it never also reaches a pick mode's
 * own Escape), when the focus leaves it, and after a pick. The keyboard:
 * Enter or Space on the button opens it with the first row focused,
 * ArrowDown on the button too; Up and Down (Home, End) move between rows;
 * Escape closes it and gives the focus back to the button; Tab closes it
 * and moves on.
 */
export class HubAccountMenu {
  private menu: HTMLDivElement | null = null;
  private anchor: HTMLButtonElement | null = null;
  private rows: HTMLButtonElement[] = [];
  /** The row the focus was last on, so a redrawn header can give it back. */
  private focusedRow: HTMLButtonElement | null = null;

  /** `host` is the account's slot in the header: the menu hangs under it, right-aligned. */
  constructor(private readonly host: HTMLElement, private readonly items: () => HubAccountMenuItem[]) {}

  get isOpen(): boolean {
    return this.menu !== null;
  }

  /** The button that opens the menu, wired for the mouse and the keyboard. */
  wire(anchor: HTMLButtonElement): HTMLButtonElement {
    anchor.setAttribute('aria-haspopup', 'menu');
    anchor.setAttribute('aria-expanded', 'false');
    anchor.addEventListener('click', () => this.toggle(anchor));
    anchor.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !this.isOpen) {
        event.preventDefault();
        this.open(anchor);
      }
    });
    return anchor;
  }

  /**
   * The header was drawn again (`host` emptied and refilled): an open menu
   * hangs under the new button, with the focus where it was, or closes when
   * there is no button any more (signed out, signing out).
   */
  redrawn(anchor: HTMLButtonElement | null): void {
    if (!this.menu) {
      return;
    }
    if (!anchor) {
      this.close();
      return;
    }
    this.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    this.host.appendChild(this.menu);
    // Taking the menu out of the page dropped the focus: it goes back where it was.
    if (!document.activeElement || document.activeElement === document.body) {
      (this.focusedRow ?? this.rows[0])?.focus();
    }
  }

  toggle(anchor: HTMLButtonElement): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(anchor);
    }
  }

  open(anchor: HTMLButtonElement): void {
    this.close();
    const menu = document.createElement('div');
    menu.dataset.ref = 'account-menu';
    menu.setAttribute('role', 'menu');
    menu.className = `${MENU_CLASS} right-0 top-[calc(100%+6px)]`;
    this.rows = this.items().map((item) => this.row(item));
    menu.append(...this.rows);
    menu.addEventListener('focusin', (event) => {
      this.focusedRow = this.rows.find((row) => row === event.target) ?? this.focusedRow;
    });
    // The focus going elsewhere (Tab, a click into the search field) closes it; to nowhere (the header redrawn) doesn't.
    menu.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && !this.host.contains(next)) {
        this.close();
      }
    });
    this.menu = menu;
    this.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    this.host.appendChild(menu);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.rows[0]?.focus();
  }

  /** Close it; `focusButton` gives the focus back to the button (Escape). */
  close(options: { focusButton?: boolean } = {}): void {
    if (!this.menu) {
      return;
    }
    const anchor = this.anchor;
    this.menu.remove();
    this.menu = null;
    this.anchor = null;
    this.rows = [];
    this.focusedRow = null;
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    anchor?.setAttribute('aria-expanded', 'false');
    if (options.focusButton && anchor?.isConnected) {
      anchor.focus();
    }
  }

  private row(item: HubAccountMenuItem): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.ref = item.ref;
    row.setAttribute('role', 'menuitem');
    row.className = MENU_ROW_CLASS;
    if (item.title) {
      row.title = item.title;
    }
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(HubIcons.span(item.icon, '[&>svg]:size-3.5 w-4 justify-center'), label);
    row.addEventListener('click', () => {
      this.close();
      item.onSelect();
    });
    return row;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // The button's own press is its click's: a toggle, not a press outside.
    if (this.host.contains(event.target as Node)) {
      return;
    }
    this.close();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close({ focusButton: true });
      return;
    }
    if (event.key === 'Tab') {
      this.close();
      return;
    }
    const moves: Record<string, (at: number, count: number) => number> = {
      ArrowDown: (at, count) => (at + 1) % count,
      ArrowUp: (at, count) => (at - 1 + count) % count,
      Home: () => 0,
      End: (_at, count) => count - 1,
    };
    const move = moves[event.key];
    // Only while the focus is on a row: the keys keep their meaning anywhere else (the search field's Home and End).
    if (!move || this.rows.length === 0 || !this.menu?.contains(document.activeElement)) {
      return;
    }
    event.preventDefault();
    const at = this.rows.indexOf(document.activeElement as HTMLButtonElement);
    this.rows[move(Math.max(at, 0), this.rows.length)].focus();
  };
}
