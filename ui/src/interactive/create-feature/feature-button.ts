import { ICON_IMG_FALLBACK } from '../../ui/object-icons';

export const TOOLBAR_BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 text-base-content/60';
export const TOOLBAR_BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0';
/** Small muted caption under the toolbar icon. */
export const TOOLBAR_BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

/**
 * The toolbar button every feature service registers: an icon with a muted
 * caption inside a daisyUI tooltip wrapper (which hides with the button so
 * no phantom toolbar gap), toggling armed styling. The service owns the
 * enter/exit toggle via `onClick`.
 *
 * The button also tracks its own visible/disabled/active state and emits
 * {@link onStateChange} on every transition, so the Finish Sketch popup can
 * mirror a subset of these buttons (see {@link FinishSketchMenu}) and delegate
 * clicks straight back to them — every service's coordination then runs
 * unchanged whether the user clicks the toolbar button or its grid twin.
 */
export class FeatureButton {
  onClick?: () => void;
  /** Fired whenever `visible`, `disabled`, or `active` changes. */
  onStateChange?: () => void;

  private readonly button: HTMLButtonElement;
  private readonly wrap: HTMLElement;
  private readonly icon: string;
  private readonly label: string;
  private _visible: boolean;
  private _disabled = false;
  private _active = false;

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
    this.icon = opts.icon;
    this.label = opts.label;
    this.button = document.createElement('button');
    this.button.className = TOOLBAR_BTN_BASE;
    this.button.setAttribute('aria-label', opts.ariaLabel);
    this.button.innerHTML = `<img src="${opts.icon}" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain shrink-0" alt="" /><span class="${TOOLBAR_BTN_LABEL}">${opts.label}</span>`;
    this.button.addEventListener('click', () => this.onClick?.());
    this.wrap = document.createElement('span');
    this.wrap.className = 'tooltip tooltip-bottom shrink-0';
    this.wrap.dataset.tip = opts.tip;
    if (opts.datasetTool) {
      this.wrap.dataset.tool = opts.datasetTool;
    }
    this.wrap.appendChild(this.button);
    this._visible = !opts.hidden;
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

  /** The button's icon URL — mirrored into the Finish Sketch grid cell. */
  get iconSrc(): string {
    return this.icon;
  }

  /** The button's caption — mirrored into the Finish Sketch grid cell. */
  get labelText(): string {
    return this.label;
  }

  get visible(): boolean {
    return this._visible;
  }

  get disabled(): boolean {
    return this._disabled;
  }

  get active(): boolean {
    return this._active;
  }

  /**
   * Programmatically trigger the button. The Finish Sketch grid delegates to
   * the real toolbar buttons this way, so a grid click runs exactly what a
   * toolbar click would (enter/exit plus every `onEnter` hook in main.ts).
   */
  click(): void {
    this.button.click();
  }

  setDisabled(disabled: boolean): void {
    if (this._disabled === disabled) {
      return;
    }
    this._disabled = disabled;
    this.button.disabled = disabled;
    this.onStateChange?.();
  }

  setActive(active: boolean): void {
    if (this._active === active) {
      return;
    }
    this._active = active;
    this.button.className = active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
    this.onStateChange?.();
  }

  setVisible(visible: boolean): void {
    if (this._visible === visible) {
      return;
    }
    this._visible = visible;
    this.wrap.classList.toggle('hidden', !visible);
    this.onStateChange?.();
  }

  /**
   * Hide (or restore) this button while the Finish Sketch button consolidates
   * the create group during sketch mode. It rides a separate class from
   * {@link setVisible} so the owning service's per-render visibility updates
   * keep flowing underneath — de-consolidating drops back to whatever `visible`
   * currently says.
   */
  setConsolidated(consolidated: boolean): void {
    this.wrap.classList.toggle('feature-consolidated', consolidated);
  }
}
