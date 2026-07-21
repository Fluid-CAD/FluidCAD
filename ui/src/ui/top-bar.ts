import { ICON_MENU, ICON_CUBE } from './icons';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';

export interface TopBarHandlers {
  /** Toggle the feature-tree (timeline) panel. */
  onToggleTree: () => void;
}

/**
 * The top application bar (Onshape-inspired): logo + wordmark, a hamburger
 * toggle for the feature-tree panel, and the current file name. Rendered as a
 * full-width overlay docked to the top of the viewer.
 */
export class TopBar {
  private el: HTMLDivElement;
  private fileLabel: HTMLSpanElement;

  constructor(container: HTMLElement, handlers: TopBarHandlers) {
    this.el = document.createElement('div');
    this.el.className =
      'absolute top-0 left-0 right-0 h-12 z-[120] flex items-center gap-2 px-3 ' +
      'panel-bg border-b border-base-content/10 select-none';

    // Logo + wordmark
    const brand = document.createElement('div');
    brand.className = 'flex items-center gap-1.5 shrink-0';
    brand.innerHTML = `
      <img src="/logo.png" alt="FluidCAD" class="h-6 w-auto opacity-80" />
      <span class="text-[17px] font-bold text-base-content/80 tracking-tight">FluidCAD</span>
    `;
    this.el.appendChild(brand);

    // Hamburger — toggles the feature-tree panel
    const menuBtn = document.createElement('button');
    menuBtn.className = BTN_BASE;
    menuBtn.title = 'Toggle feature tree';
    menuBtn.innerHTML = `<span class="[&>svg]:size-5">${ICON_MENU}</span>`;
    menuBtn.addEventListener('click', () => handlers.onToggleTree());
    this.el.appendChild(menuBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
    this.el.appendChild(divider);

    // File name
    const fileRow = document.createElement('div');
    fileRow.className = 'flex items-center gap-2 min-w-0';
    fileRow.innerHTML = `
      <span class="text-base-content/50 shrink-0 [&>svg]:size-4">${ICON_CUBE}</span>
      <span data-ref="filename" class="text-sm text-base-content/70 truncate max-w-[40vw]"></span>
    `;
    this.el.appendChild(fileRow);
    this.fileLabel = fileRow.querySelector('[data-ref="filename"]')!;

    container.appendChild(this.el);
  }

  setFileName(absPath: string): void {
    const fileName = absPath.split('/').pop() || absPath;
    this.fileLabel.textContent = fileName;
  }
}
