import { Navbar } from './navbar';
import { ICON_IMG_FALLBACK } from './object-icons';
import { TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from './toolbar-styles';

/** The click handlers main.ts wires the implemented assembly tools to. */
export type AssemblyToolbarHandlers = {
  onInsert?: () => void;
};

/**
 * The assembly workbench's tool groups on the {@link Navbar}. Registered once
 * at startup with `mode: 'assembly'`, so the navbar shows them (and hides
 * every part-design group) whenever the scene kind flips to assembly — see
 * `Navbar.setMode`.
 *
 * Insert opens the part-catalog dialog; the remaining buttons are
 * placeholders that render like the real part-design tools but only announce
 * themselves as unimplemented when clicked. The groups mirror the planned
 * assembly features — Insert (bring a part in) and one button per mate type.
 */
export class AssemblyToolbar {
  constructor(navbar: Navbar, handlers: AssemblyToolbarHandlers = {}) {
    const insertGroup = navbar.addGroup('assembly-insert', { mode: 'assembly' });
    if (handlers.onInsert) {
      this.addButton(insertGroup, { icon: 'insert', label: 'Insert', tip: 'Insert part' }, handlers.onInsert);
    } else {
      this.addPlaceholder(insertGroup, { icon: 'insert', label: 'Insert', tip: 'Insert part' });
    }

    // One button per mate type of the assembly solver (SerializedMate['type']),
    // plus Spherical, which has artwork but no solver support yet.
    const mateGroup = navbar.addGroup('assembly-mate', { mode: 'assembly' });
    this.addPlaceholder(mateGroup, { icon: 'joint-fastened', label: 'Fastened', tip: 'Fastened mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-revolute', label: 'Revolute', tip: 'Revolute mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-slider', label: 'Slider', tip: 'Slider mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-cylindrical', label: 'Cylindrical', tip: 'Cylindrical mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-planar', label: 'Planar', tip: 'Planar mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-parallel', label: 'Parallel', tip: 'Parallel mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-pin-slot', label: 'Pin-slot', tip: 'Pin-slot mate' });
    this.addPlaceholder(mateGroup, { icon: 'joint-spherical', label: 'Spherical', tip: 'Spherical mate' });
  }

  /** Standard toolbar button markup: icon over muted caption in a tooltip wrapper. */
  private addButton(
    group: HTMLElement,
    opts: { icon: string; label: string; tip: string },
    onClick: () => void,
    tipSuffix = '',
  ): void {
    const button = document.createElement('button');
    button.className = TOOLBAR_BTN_BASE;
    button.setAttribute('aria-label', opts.tip);
    button.innerHTML =
      `<img src="/icons/${opts.icon}.png" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
      + `<span class="${TOOLBAR_BTN_LABEL}">${opts.label}</span>`;
    button.addEventListener('click', onClick);
    const wrap = document.createElement('span');
    wrap.className = 'tooltip tooltip-bottom shrink-0';
    wrap.dataset.tip = `${opts.tip}${tipSuffix}`;
    wrap.appendChild(button);
    group.appendChild(wrap);
  }

  /** A not-yet-implemented tool: real-looking button that only warns on click. */
  private addPlaceholder(group: HTMLElement, opts: { icon: string; label: string; tip: string }): void {
    this.addButton(group, opts, () => {
      console.warn(`${opts.tip} not implemented yet`);
    }, ' (coming soon)');
  }
}
