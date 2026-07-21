import { ICON_IMG_FALLBACK } from '../../ui/object-icons';

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

/**
 * The toolbar button every feature service registers: an icon with a muted
 * caption inside a daisyUI tooltip wrapper (which hides with the button so
 * no phantom toolbar gap), toggling armed styling. The service owns the
 * enter/exit toggle via `onClick`.
 */
export class FeatureButton {
  onClick?: () => void;

  private readonly button: HTMLButtonElement;
  private readonly wrap: HTMLElement;

  constructor(group: HTMLElement, opts: {
    icon: string;
    label: string;
    tip: string;
    ariaLabel: string;
    /** `data-tool` marker on the wrapper — an anchor for sibling buttons. */
    datasetTool?: string;
    /** Prepend to the group instead of appending (the Plane button). */
    prepend?: boolean;
    /** Insert before this element instead of appending (the Shell button). */
    insertBefore?: Element | null;
    /** Start hidden (buttons gated on the first render's scene). */
    hidden?: boolean;
  }) {
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.setAttribute('aria-label', opts.ariaLabel);
    this.button.innerHTML = `<img src="${opts.icon}" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain shrink-0" alt="" /><span class="${BTN_LABEL}">${opts.label}</span>`;
    this.button.addEventListener('click', () => this.onClick?.());
    this.wrap = document.createElement('span');
    this.wrap.className = 'tooltip tooltip-bottom shrink-0';
    this.wrap.dataset.tip = opts.tip;
    if (opts.datasetTool) {
      this.wrap.dataset.tool = opts.datasetTool;
    }
    this.wrap.appendChild(this.button);
    if (opts.hidden) {
      this.wrap.classList.add('hidden');
    }
    if (opts.prepend) {
      group.prepend(this.wrap);
    } else if (opts.insertBefore !== undefined) {
      group.insertBefore(this.wrap, opts.insertBefore);
    } else {
      group.appendChild(this.wrap);
    }
  }

  setDisabled(disabled: boolean): void {
    this.button.disabled = disabled;
  }

  setActive(active: boolean): void {
    this.button.className = active ? BTN_ACTIVE : BTN_BASE;
  }

  setVisible(visible: boolean): void {
    this.wrap.classList.toggle('hidden', !visible);
  }
}
