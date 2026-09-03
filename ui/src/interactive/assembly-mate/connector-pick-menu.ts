import { MENU_CLASS, MENU_HEADER_CLASS, MENU_ROW_CLASS } from '../../ui/menu-styles';
import { escapeHtml } from '../../ui/expression-core';

export type ConnectorPickMenuItem = {
  label: string;
  onHover: () => void;
  onPick: () => void;
};

/**
 * The "which connector?" popover a mate-dialog click opens when several
 * gizmos sit under the cursor — an assembly connector placed exactly on a
 * part connector. Hovering a row highlights that gizmo; clicking one picks
 * it. Escape, a click elsewhere, or a wheel gesture dismiss it.
 */
export class ConnectorPickMenu {
  private el: HTMLDivElement | null = null;
  private dismiss: (() => void) | null = null;

  constructor(private readonly container: HTMLElement) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  show(clientX: number, clientY: number, items: ConnectorPickMenuItem[], onLeave: () => void): void {
    this.close();
    const el = document.createElement('div');
    el.className = MENU_CLASS;
    el.setAttribute('role', 'menu');
    el.dataset.role = 'connector-pick-menu';
    el.innerHTML = `<div class="${MENU_HEADER_CLASS}">Which connector?</div>`
      + items.map((item, i) =>
        `<button type="button" role="menuitem" class="${MENU_ROW_CLASS}" data-index="${i}">${escapeHtml(item.label)}</button>`,
      ).join('');
    const rect = this.container.getBoundingClientRect();
    el.style.left = `${Math.round(clientX - rect.left + 6)}px`;
    el.style.top = `${Math.round(clientY - rect.top + 6)}px`;
    this.container.appendChild(el);
    this.el = el;
    el.querySelectorAll<HTMLButtonElement>('[data-index]').forEach((button) => {
      const item = items[Number(button.dataset.index)];
      button.addEventListener('mouseenter', () => item.onHover());
      button.addEventListener('mouseleave', () => onLeave());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.close();
        item.onPick();
      });
    });
    // Keep the menu inside the viewport.
    const menuRect = el.getBoundingClientRect();
    if (menuRect.right > rect.right) {
      el.style.left = `${Math.max(0, Math.round(clientX - rect.left - menuRect.width - 6))}px`;
    }
    if (menuRect.bottom > rect.bottom) {
      el.style.top = `${Math.max(0, Math.round(clientY - rect.top - menuRect.height - 6))}px`;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!el.contains(event.target as Node)) {
        onLeave();
        this.close();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onLeave();
        this.close();
      }
    };
    const onWheel = () => {
      onLeave();
      this.close();
    };
    // Registered after the opening click has finished bubbling.
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    }, 0);
    this.dismiss = () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onWheel, true);
    };
    (el.querySelector<HTMLButtonElement>('[data-index="0"]'))?.focus();
  }

  close(): void {
    this.dismiss?.();
    this.dismiss = null;
    this.el?.remove();
    this.el = null;
  }
}
