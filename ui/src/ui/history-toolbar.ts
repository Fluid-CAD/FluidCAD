import type { Navbar } from './navbar';
import { ICON_UNDO, ICON_REDO } from './icons';
import { TOOLBAR_BTN_BASE, TOOLBAR_BTN_LABEL } from './toolbar-styles';

export interface HistoryToolbarHandlers {
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * The editor-history group — Undo/Redo, first on the bar. The buttons drive
 * the attached editor's native undo stack (every UI-applied operation lands
 * there as one edit), so the group only shows once an editor host has
 * announced the capability ({@link setAvailable}); a server without an editor
 * (standalone serve, hub) never announces and the group stays hidden. The
 * `immune` flag keeps it reachable while the sketch toolbar owns the bar.
 *
 * The buttons stay enabled even when there is nothing left to undo — neither
 * editor exposes its stack depth cheaply — and simply no-op at the ends of
 * the history, like mashing Ctrl+Z in the editor would.
 */
export class HistoryToolbar {
  private navbar: Navbar;
  private available = false;

  constructor(navbar: Navbar, handlers: HistoryToolbarHandlers) {
    this.navbar = navbar;
    const group = navbar.addGroup('history', { visible: false, immune: true });
    this.addButton(group, ICON_UNDO, 'Undo', handlers.onUndo);
    this.addButton(group, ICON_REDO, 'Redo', handlers.onRedo);
  }

  /** Show the group once the attached editor has declared undo/redo support. */
  setAvailable(available: boolean): void {
    if (this.available === available) {
      return;
    }
    this.available = available;
    this.navbar.setGroupVisible('history', available);
  }

  private addButton(group: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = document.createElement('button');
    button.className = TOOLBAR_BTN_BASE;
    button.setAttribute('aria-label', label);
    button.innerHTML =
      `<span class="w-7 h-7 shrink-0 flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">${icon}</span>`
      + `<span class="${TOOLBAR_BTN_LABEL}">${label}</span>`;
    button.addEventListener('click', onClick);
    const wrap = document.createElement('span');
    wrap.className = 'tooltip tooltip-bottom shrink-0';
    wrap.dataset.tip = label;
    wrap.appendChild(button);
    group.appendChild(wrap);
  }
}
