// The solved-sketch constraint bar (sketch-rewrite P4): a floating row of
// constraint/dimension buttons below the main toolbar, replacing the legacy
// segment-conversion bar inside solved sketches. Dumb view — the service
// decides enablement and applies statements. Buttons are icon-only: the
// artwork comes from CONSTRAINT_KIND_ICONS (shared with the timeline rows)
// and `aria-label`/tooltip carry the name.

import {
  CONSTRAINT_KIND_ICONS,
  CONSTRAINT_REMOVE_ICON,
  ICON_IMG_FALLBACK,
} from '../../ui/object-icons';
import type { ConstraintButtonId, ConstraintOption } from './legality';

const BUTTONS: { id: ConstraintButtonId; label: string }[] = [
  { id: 'coincident', label: 'Coincident' },
  { id: 'horizontal', label: 'Horizontal' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'parallel', label: 'Parallel' },
  { id: 'perpendicular', label: 'Perpendicular' },
  { id: 'tangent', label: 'Tangent' },
  { id: 'equal', label: 'Equal' },
  { id: 'concentric', label: 'Concentric' },
  { id: 'collinear', label: 'Collinear' },
  { id: 'midpoint', label: 'Midpoint' },
  { id: 'symmetric', label: 'Symmetric' },
  { id: 'fix', label: 'Fix' },
  { id: 'dimension', label: 'Dimension' },
  { id: 'angle', label: 'Angle' },
];

/**
 * Letter chords for the constraint buttons, typed with nothing focused while
 * the bar is up. They share the sketch-mode ShortcutManager with the drawing
 * tools (`c` circle, `l` line, `p` polygon, `m` mirror, `f` fillet, `a`
 * arc…), so the kinds whose initial is taken use a two-letter chord; single
 * letters go to the kinds whose initial is free. Each chord fires the same
 * path as a click, and only while the button is enabled for the picks —
 * otherwise the key is not consumed at all.
 */
export const CONSTRAINT_SHORTCUTS: Record<ConstraintButtonId, string> = {
  coincident: 'cc',
  horizontal: 'h',
  vertical: 'v',
  parallel: 'pa',
  perpendicular: 'pe',
  tangent: 't',
  equal: 'e',
  concentric: 'cn',
  collinear: 'cl',
  midpoint: 'mp',
  symmetric: 's',
  fix: 'fx',
  dimension: 'd',
  angle: 'da',
};

/**
 * Button ids are constraint kinds, with one exception: `dimension` arms the
 * two-pick flow that ends in a distance/radius/diameter statement, so it
 * wears the distance artwork.
 */
function iconFor(id: ConstraintButtonId): string {
  return CONSTRAINT_KIND_ICONS[id === 'dimension' ? 'distance' : id];
}

const BTN_ENABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0';
const BTN_DISABLED = 'btn btn-ghost btn-sm px-1.5 shrink-0 btn-disabled';
const BTN_ARMED = 'btn btn-soft btn-primary btn-sm px-1.5 shrink-0';
/** The artwork carries its own colour, so disabling desaturates instead. */
const ICON_ENABLED = 'w-5 h-5 object-contain shrink-0';
const ICON_DISABLED = 'w-5 h-5 object-contain shrink-0 opacity-30 grayscale';

export class SolvedConstraintToolbar {
  /** Fired when an enabled constraint button is clicked. */
  onApply?: (id: ConstraintButtonId) => void;
  /** Fired when the delete button is clicked (a constraint badge is picked). */
  onDelete?: () => void;
  /** Fired when an enabled button is hovered/unhovered — the ghost preview. */
  onHoverButton?: (id: ConstraintButtonId | null) => void;

  private root: HTMLDivElement;
  private buttons = new Map<ConstraintButtonId, HTMLButtonElement>();
  private icons = new Map<ConstraintButtonId, HTMLImageElement>();
  private tooltips = new Map<ConstraintButtonId, HTMLDivElement>();
  private deleteBtn: HTMLButtonElement;
  private deleteIcon: HTMLImageElement;
  private deleteTip: HTMLDivElement;
  private options: ConstraintOption[] = [];
  private busy = false;
  private dimensionArmed = false;
  private deleteEnabled = false;
  private deleteLabel: string | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    // Same overlay slot as the legacy conversion bar (the two never show
    // together — this one owns solved sketches). z below the navbar's 120.
    this.root.className = 'absolute top-[106px] left-[calc(50%+var(--fluidcad-editor-width,0px)/2)] -translate-x-1/2 z-[110] '
      + 'panel-bg border border-base-content/10 rounded-md shadow-sm '
      + 'px-1.5 py-1 flex items-center gap-0.5 hidden';

    for (const { id, label } of BUTTONS) {
      if (id === 'dimension') {
        this.root.appendChild(this.divider());
      }
      const { wrapper, btn, icon, tip } = this.button(iconFor(id), label);
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
      this.icons.set(id, icon);
      this.tooltips.set(id, tip);
    }

    this.root.appendChild(this.divider());
    const del = this.button(CONSTRAINT_REMOVE_ICON, 'Delete constraint');
    del.btn.addEventListener('click', () => {
      if (!del.btn.disabled) {
        this.onDelete?.();
      }
    });
    this.root.appendChild(del.wrapper);
    this.deleteBtn = del.btn;
    this.deleteIcon = del.icon;
    this.deleteTip = del.tip;

    this.render();
    container.appendChild(this.root);
  }

  private divider(): HTMLDivElement {
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/[0.12] mx-0.5 shrink-0';
    return divider;
  }

  private button(iconPng: string, label: string): {
    wrapper: HTMLDivElement; btn: HTMLButtonElement; icon: HTMLImageElement; tip: HTMLDivElement;
  } {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group shrink-0';
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<img src="/icons/${iconPng}.png" ${ICON_IMG_FALLBACK} class="${ICON_ENABLED}" alt="" />`;
    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded '
      + 'bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none '
      + 'group-hover:opacity-100 transition-opacity z-[200]';
    tip.textContent = label;
    wrapper.appendChild(btn);
    wrapper.appendChild(tip);
    return { wrapper, btn, icon: btn.querySelector('img')!, tip };
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

  /** `label` names what Delete would remove when it is not a picked badge
   * (a vertex pick standing in for its coincident ring). */
  setDeleteEnabled(enabled: boolean, label?: string): void {
    this.deleteEnabled = enabled;
    this.deleteLabel = enabled ? label ?? null : null;
    this.render();
  }

  /** Whether a click (or its shortcut) on `id` would do anything right now. */
  isEnabled(id: ConstraintButtonId): boolean {
    const btn = this.buttons.get(id);
    return btn !== undefined && !btn.disabled;
  }

  private render(): void {
    for (const { id, label } of BUTTONS) {
      const btn = this.buttons.get(id)!;
      const icon = this.icons.get(id)!;
      const tip = this.tooltips.get(id)!;
      const option = this.options.find(o => o.id === id);
      // The dimension tool arms without a legal pick set — that IS the
      // two-pick flow: arm first, pick twice, get the value input.
      const armed = id === 'dimension' && this.dimensionArmed;
      const enabled = !this.busy && (armed || option?.enabled === true || id === 'dimension');
      btn.disabled = !enabled;
      btn.className = armed ? BTN_ARMED : enabled ? BTN_ENABLED : BTN_DISABLED;
      icon.className = enabled ? ICON_ENABLED : ICON_DISABLED;
      const text = armed
        ? 'Dimension armed — pick two points/entities, one line, or one circle/arc'
        : option?.enabled
          ? `Add ${label.toLowerCase()}`
          : option?.reason
            ? `${label} — ${option.reason}`
            : label;
      tip.textContent = text;
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd kbd-xs ml-1.5';
      kbd.textContent = CONSTRAINT_SHORTCUTS[id];
      tip.appendChild(kbd);
    }
    this.deleteBtn.disabled = this.busy || !this.deleteEnabled;
    this.deleteBtn.className = this.deleteBtn.disabled ? BTN_DISABLED : BTN_ENABLED;
    this.deleteIcon.className = this.deleteBtn.disabled ? ICON_DISABLED : ICON_ENABLED;
    this.deleteTip.textContent = this.deleteEnabled
      ? `${this.deleteLabel ?? 'Delete the picked constraint'} (Del)`
      : 'Click a constraint badge, or a vertex that shares a coincident, to pick it';
  }
}
