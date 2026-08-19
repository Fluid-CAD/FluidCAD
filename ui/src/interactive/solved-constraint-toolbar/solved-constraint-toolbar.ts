// The solved-sketch constraint bar (sketch-rewrite P4): a floating row of
// constraint/dimension buttons below the main toolbar, replacing the legacy
// segment-conversion bar inside solved sketches. Dumb view — the service
// decides enablement and applies statements. Buttons render their badge
// glyphs as text (dedicated artwork owed, the usual placeholder pattern).

import type { ConstraintButtonId, ConstraintOption } from './legality';

const BUTTONS: { id: ConstraintButtonId; glyph: string; label: string }[] = [
  { id: 'coincident', glyph: '∙', label: 'Coincident' },
  { id: 'horizontal', glyph: 'H', label: 'Horizontal' },
  { id: 'vertical', glyph: 'V', label: 'Vertical' },
  { id: 'parallel', glyph: '∥', label: 'Parallel' },
  { id: 'perpendicular', glyph: '⊥', label: 'Perpendicular' },
  { id: 'tangent', glyph: 'T', label: 'Tangent' },
  { id: 'equal', glyph: '=', label: 'Equal' },
  { id: 'concentric', glyph: '◎', label: 'Concentric' },
  { id: 'collinear', glyph: '≡', label: 'Collinear' },
  { id: 'midpoint', glyph: 'M', label: 'Midpoint' },
  { id: 'symmetric', glyph: 'S', label: 'Symmetric' },
  { id: 'fix', glyph: 'F', label: 'Fix' },
  { id: 'dimension', glyph: '⟷', label: 'Dimension' },
  { id: 'angle', glyph: '∠', label: 'Angle' },
];

const BTN_ENABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0 font-semibold';
const BTN_DISABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0 font-semibold btn-disabled opacity-40';
const BTN_ARMED = 'btn btn-soft btn-primary btn-sm px-1.5 shrink-0 font-semibold';

export class SolvedConstraintToolbar {
  /** Fired when an enabled constraint button is clicked. */
  onApply?: (id: ConstraintButtonId) => void;
  /** Fired when the delete button is clicked (a constraint badge is picked). */
  onDelete?: () => void;
  /** Fired when an enabled button is hovered/unhovered — the ghost preview. */
  onHoverButton?: (id: ConstraintButtonId | null) => void;

  private root: HTMLDivElement;
  private buttons = new Map<ConstraintButtonId, HTMLButtonElement>();
  private tooltips = new Map<ConstraintButtonId, HTMLDivElement>();
  private deleteBtn: HTMLButtonElement;
  private deleteTip: HTMLDivElement;
  private options: ConstraintOption[] = [];
  private busy = false;
  private dimensionArmed = false;
  private deleteEnabled = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    // Same overlay slot as the legacy conversion bar (the two never show
    // together — this one owns solved sketches). z below the navbar's 120.
    this.root.className = 'absolute top-[106px] left-1/2 -translate-x-1/2 z-[110] '
      + 'panel-bg border border-base-content/10 rounded-md shadow-sm '
      + 'px-1.5 py-1 flex items-center gap-0.5 hidden';

    for (const { id, glyph, label } of BUTTONS) {
      if (id === 'dimension') {
        this.root.appendChild(this.divider());
      }
      const { wrapper, btn, tip } = this.button(glyph, label);
      btn.addEventListener('click', () => {
        if (!btn.disabled) {
          this.onApply?.(id);
        }
      });
      btn.addEventListener('mouseenter', () => {
        if (!btn.disabled) {
          this.onHoverButton?.(id);
        }
      });
      btn.addEventListener('mouseleave', () => this.onHoverButton?.(null));
      this.root.appendChild(wrapper);
      this.buttons.set(id, btn);
      this.tooltips.set(id, tip);
    }

    this.root.appendChild(this.divider());
    const del = this.button('✕', 'Delete constraint');
    del.btn.addEventListener('click', () => {
      if (!del.btn.disabled) {
        this.onDelete?.();
      }
    });
    this.root.appendChild(del.wrapper);
    this.deleteBtn = del.btn;
    this.deleteTip = del.tip;

    this.render();
    container.appendChild(this.root);
  }

  private divider(): HTMLDivElement {
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/[0.12] mx-0.5 shrink-0';
    return divider;
  }

  private button(glyph: string, label: string): {
    wrapper: HTMLDivElement; btn: HTMLButtonElement; tip: HTMLDivElement;
  } {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group shrink-0';
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', label);
    btn.textContent = glyph;
    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded '
      + 'bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none '
      + 'group-hover:opacity-100 transition-opacity z-[200]';
    tip.textContent = label;
    wrapper.appendChild(btn);
    wrapper.appendChild(tip);
    return { wrapper, btn, tip };
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  setOptions(options: ConstraintOption[]): void {
    this.options = options;
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  /** The two-pick dimension flow's armed state (locked plan §0.4). */
  setDimensionArmed(armed: boolean): void {
    this.dimensionArmed = armed;
    this.render();
  }

  setDeleteEnabled(enabled: boolean): void {
    this.deleteEnabled = enabled;
    this.render();
  }

  private render(): void {
    for (const { id, label } of BUTTONS) {
      const btn = this.buttons.get(id)!;
      const tip = this.tooltips.get(id)!;
      const option = this.options.find(o => o.id === id);
      // The dimension tool arms without a legal pick set — that IS the
      // two-pick flow: arm first, pick twice, get the value input.
      const armed = id === 'dimension' && this.dimensionArmed;
      const enabled = !this.busy && (armed || option?.enabled === true || id === 'dimension');
      btn.disabled = !enabled;
      btn.className = armed ? BTN_ARMED : enabled ? BTN_ENABLED : BTN_DISABLED;
      tip.textContent = armed
        ? 'Dimension armed — pick two points/entities, one line, or one circle/arc'
        : option?.enabled
          ? `Add ${label.toLowerCase()}`
          : option?.reason
            ? `${label} — ${option.reason}`
            : label;
    }
    this.deleteBtn.disabled = this.busy || !this.deleteEnabled;
    this.deleteBtn.className = this.deleteBtn.disabled ? BTN_DISABLED : BTN_ENABLED;
    this.deleteTip.textContent = this.deleteEnabled
      ? 'Delete the picked constraint (Del)'
      : 'Click a constraint badge to pick it';
  }
}
