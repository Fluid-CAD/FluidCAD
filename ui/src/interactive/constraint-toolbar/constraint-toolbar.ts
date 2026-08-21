import { ConversionOption, ConversionTarget } from '../../api';
import {
  CONSTRAINT_KIND_ICONS,
  CONSTRAINT_REMOVE_ICON,
  ICON_IMG_FALLBACK,
} from '../../ui/object-icons';

/**
 * Button order; `free` renders after a divider (it undoes the others).
 * `iconPng` is the basename of the artwork under `/icons`; `label` no longer
 * shows on the button itself and survives only in the tooltip.
 */
const TARGETS: { target: ConversionTarget; label: string; iconPng: string }[] = [
  { target: 'hLine', label: 'H-Line', iconPng: CONSTRAINT_KIND_ICONS.horizontal },
  { target: 'vLine', label: 'V-Line', iconPng: CONSTRAINT_KIND_ICONS.vertical },
  // The constraint set draws tangency once, so the two tangent conversions
  // share it and separate on their tooltips; the segment-shape artwork
  // (tline/tarc) belongs to the drawing tools, not to this bar.
  { target: 'tLine', label: 'T-Line', iconPng: CONSTRAINT_KIND_ICONS.tangent },
  { target: 'aLine', label: 'A-Line', iconPng: CONSTRAINT_KIND_ICONS.angle },
  { target: 'tArc', label: 'T-Arc', iconPng: CONSTRAINT_KIND_ICONS.tangent },
  { target: 'free', label: 'Free', iconPng: CONSTRAINT_REMOVE_ICON },
];

const NO_SELECTION_TIP = 'Select a chained segment to convert it';
const NOT_AVAILABLE_TIP = 'Not available for this segment';

/** Endpoint moves smaller than this round to invisible at drawing precision. */
const ENDPOINT_DELTA_EPSILON = 0.005;

const BTN_ENABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0';
const BTN_DISABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0 btn-disabled';
/** The artwork carries its own colour, so disabling desaturates instead. */
const ICON_ENABLED = 'w-5 h-5 object-contain shrink-0';
const ICON_DISABLED = 'w-5 h-5 object-contain shrink-0 opacity-30 grayscale';

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
  private icons = new Map<ConversionTarget, HTMLImageElement>();
  private tooltips = new Map<ConversionTarget, HTMLDivElement>();
  private options: ConversionOption[] | null = null;
  private emptyTooltip = NO_SELECTION_TIP;
  private busy = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    // z stays below the navbar's z-[120]: the navbar is a stacking context, so
    // its popups (Finish Sketch grid) can never out-stack a heavier sibling.
    this.root.className = 'absolute top-[106px] left-1/2 -translate-x-1/2 z-[110] '
      + 'panel-bg border border-base-content/10 rounded-md shadow-sm '
      + 'px-1.5 py-1 flex items-center gap-1 hidden';

    for (const { target, label, iconPng } of TARGETS) {
      if (target === 'free') {
        const divider = document.createElement('div');
        divider.className = 'w-px h-5 bg-base-content/[0.12] mx-0.5 shrink-0';
        this.root.appendChild(divider);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'relative group shrink-0';

      const btn = document.createElement('button');
      btn.setAttribute('aria-label', label);
      btn.innerHTML = `<img src="/icons/${iconPng}.png" ${ICON_IMG_FALLBACK} class="${ICON_ENABLED}" alt="" />`;
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
      this.icons.set(target, btn.querySelector('img')!);
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
      const icon = this.icons.get(target)!;
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
        if (option.reshapeAngle !== undefined) {
          tooltip += ` — reshapes the arc by ~${option.reshapeAngle.toFixed(1)}°`;
        }
      }

      btn.disabled = !enabled;
      btn.className = enabled ? BTN_ENABLED : BTN_DISABLED;
      icon.className = enabled ? ICON_ENABLED : ICON_DISABLED;
      tip.textContent = tooltip;
    }
  }
}
