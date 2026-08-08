import { Navbar } from './navbar';
import { ICON_IMG_FALLBACK } from './object-icons';
import { TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from './toolbar-styles';

/**
 * The assembly workbench's tool groups on the {@link Navbar}. Registered once
 * at startup with `mode: 'assembly'`, so the navbar shows them (and hides
 * every part-design group) whenever the scene kind flips to assembly — see
 * `Navbar.setMode`.
 *
 * All buttons are placeholders for now: they render like the real part-design
 * tools but only announce themselves as unimplemented when clicked. The
 * groups mirror the planned assembly features — Insert (bring a part in),
 * Translate (position an instance), and one button per mate type.
 */
export class AssemblyToolbar {
  constructor(navbar: Navbar) {
    const insertGroup = navbar.addGroup('assembly-insert', { mode: 'assembly' });
    this.addPlaceholder(insertGroup, { icon: 'load', label: 'Insert', tip: 'Insert part' });

    const transformGroup = navbar.addGroup('assembly-transform', { mode: 'assembly' });
    this.addPlaceholder(transformGroup, { icon: 'translate', label: 'Translate', tip: 'Translate instance' });

    // One button per mate type of the assembly solver (SerializedMate['type']).
    const mateGroup = navbar.addGroup('assembly-mate', { mode: 'assembly' });
    this.addPlaceholder(mateGroup, { icon: 'connect', label: 'Fastened', tip: 'Fastened mate' });
    this.addPlaceholder(mateGroup, { icon: 'rotate', label: 'Revolute', tip: 'Revolute mate' });
    this.addPlaceholder(mateGroup, { icon: 'hmove', label: 'Slider', tip: 'Slider mate' });
    this.addPlaceholder(mateGroup, { icon: 'cylinder', label: 'Cylindrical', tip: 'Cylindrical mate' });
    this.addPlaceholder(mateGroup, { icon: 'plane', label: 'Planar', tip: 'Planar mate' });
    this.addPlaceholder(mateGroup, { icon: 'axis', label: 'Parallel', tip: 'Parallel mate' });
    this.addPlaceholder(mateGroup, { icon: 'slot', label: 'Pin-slot', tip: 'Pin-slot mate' });
  }

  /** Same markup as every other toolbar button (icon over muted caption in a
   *  tooltip wrapper), minus a real handler. */
  private addPlaceholder(group: HTMLElement, opts: { icon: string; label: string; tip: string }): void {
    const button = document.createElement('button');
    button.className = TOOLBAR_BTN_BASE;
    button.setAttribute('aria-label', opts.tip);
    button.innerHTML =
      `<img src="/icons/${opts.icon}.png" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
      + `<span class="${TOOLBAR_BTN_LABEL}">${opts.label}</span>`;
    button.addEventListener('click', () => {
      console.warn(`${opts.tip} not implemented yet`);
    });
    const wrap = document.createElement('span');
    wrap.className = 'tooltip tooltip-bottom shrink-0';
    wrap.dataset.tip = `${opts.tip} (coming soon)`;
    wrap.appendChild(button);
    group.appendChild(wrap);
  }
}
