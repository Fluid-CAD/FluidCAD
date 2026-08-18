import { Navbar } from './navbar';
import { ICON_IMG_FALLBACK } from './object-icons';
import { TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from './toolbar-styles';
import type { AssemblyMateType } from '../api';

/** The click handlers main.ts wires the implemented assembly tools to. */
export type AssemblyToolbarHandlers = {
  onInsert?: () => void;
  /** A mate button — opens the mate dialog with that type preselected. */
  onMate?: (type: AssemblyMateType) => void;
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

    // One button per mate type the solver implements (JOINT_SPECS in
    // ui/src/solver/joint-model.ts). Types the solver doesn't support yet are
    // commented out below — restore each entry when its phase lands.
    const mateGroup = navbar.addGroup('assembly-mate', { mode: 'assembly' });
    const mates: { type: AssemblyMateType; label: string }[] = [
      { type: 'fastened', label: 'Fastened' },
      { type: 'revolute', label: 'Revolute' },
      { type: 'slider', label: 'Slider' },
      { type: 'cylindrical', label: 'Cylindrical' },
      { type: 'planar', label: 'Planar' },
      // Placeholder icon (copy of joint-planar) — replace with a real one.
      { type: 'tangent', label: 'Tangent' },
      // { type: 'parallel', label: 'Parallel' },
      // { type: 'pin-slot', label: 'Pin-slot' },
    ];
    for (const { type, label } of mates) {
      const opts = { icon: `joint-${type}`, label, tip: `${label} mate` };
      if (handlers.onMate) {
        this.addButton(mateGroup, opts, () => handlers.onMate!(type));
      } else {
        this.addPlaceholder(mateGroup, opts);
      }
    }
    // this.addPlaceholder(mateGroup, { icon: 'joint-spherical', label: 'Spherical', tip: 'Spherical mate' });
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
