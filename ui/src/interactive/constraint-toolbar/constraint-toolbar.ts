import { ConversionOption, ConversionTarget } from '../../api';

/** Button order; `free` renders after a divider (it undoes the others). */
const TARGETS: { target: ConversionTarget; label: string }[] = [
  { target: 'hLine', label: 'H-Line' },
  { target: 'vLine', label: 'V-Line' },
  { target: 'tLine', label: 'T-Line' },
  { target: 'aLine', label: 'A-Line' },
  { target: 'tArc', label: 'T-Arc' },
  { target: 'free', label: 'Free' },
];

const NO_SELECTION_TIP = 'Select a chained segment to convert it';
const NOT_AVAILABLE_TIP = 'Not available for this segment';

/** Endpoint moves smaller than this round to invisible at drawing precision. */
const ENDPOINT_DELTA_EPSILON = 0.005;

const BTN_ENABLED = 'btn btn-ghost btn-xs px-2 shrink-0 text-base-content/80';
const BTN_DISABLED = 'btn btn-ghost btn-xs px-2 shrink-0 text-base-content/30 btn-disabled';

/**
 * The constraint mini-toolbar: a floating row of conversion buttons below the
 * main toolbar. Dumb view — {@link ConstraintToolbarService} decides what is
 * enabled and applies the conversions.
 */
export class ConstraintToolbar {
  /** Fired when an enabled button is clicked. */
  onConvert?: (target: ConversionTarget) => void;

  private root: HTMLDivElement;
  private buttons = new Map<ConversionTarget, HTMLButtonElement>();
  private tooltips = new Map<ConversionTarget, HTMLDivElement>();
  private options: ConversionOption[] | null = null;
  private emptyTooltip = NO_SELECTION_TIP;
  private busy = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'absolute top-[106px] left-1/2 -translate-x-1/2 z-[140] '
      + 'panel-bg border border-base-content/10 rounded-md shadow-sm '
      + 'px-1.5 py-1 flex items-center gap-1 hidden';

    for (const { target, label } of TARGETS) {
      if (target === 'free') {
        const divider = document.createElement('div');
        divider.className = 'w-px h-5 bg-base-content/[0.12] mx-0.5 shrink-0';
        this.root.appendChild(divider);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'relative group shrink-0';

      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (!btn.disabled) {
          this.onConvert?.(target);
        }
      });

      const tip = document.createElement('div');
      tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded '
        + 'bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none '
        + 'group-hover:opacity-100 transition-opacity z-[200]';

      wrapper.appendChild(btn);
      wrapper.appendChild(tip);
      this.root.appendChild(wrapper);
      this.buttons.set(target, btn);
      this.tooltips.set(target, tip);
    }

    this.render();
    container.appendChild(this.root);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /**
   * The conversions offered for the current selection; null means no (usable)
   * selection — every button disables with `emptyTooltip` explaining why.
   */
  setOptions(options: ConversionOption[] | null, emptyTooltip = NO_SELECTION_TIP): void {
    this.options = options;
    this.emptyTooltip = emptyTooltip;
    this.render();
  }

  /** Disable everything while a conversion is in flight. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  private render(): void {
    for (const { target, label } of TARGETS) {
      const btn = this.buttons.get(target)!;
      const tip = this.tooltips.get(target)!;
      const option = this.options?.find((o) => o.target === target);

      let enabled: boolean;
      let tooltip: string;
      if (!this.options) {
        enabled = false;
        tooltip = this.emptyTooltip;
      } else if (!option) {
        enabled = false;
        tooltip = NOT_AVAILABLE_TIP;
      } else if (!option.enabled) {
        enabled = false;
        tooltip = option.reason ?? NOT_AVAILABLE_TIP;
      } else {
        enabled = !this.busy;
        tooltip = `Convert to ${label}`;
        if (option.endpointDelta !== undefined && option.endpointDelta > ENDPOINT_DELTA_EPSILON) {
          tooltip += ` — moves endpoint by ~${option.endpointDelta.toFixed(2)} mm`;
        }
      }

      btn.disabled = !enabled;
      btn.className = enabled ? BTN_ENABLED : BTN_DISABLED;
      tip.textContent = tooltip;
    }
  }
}
