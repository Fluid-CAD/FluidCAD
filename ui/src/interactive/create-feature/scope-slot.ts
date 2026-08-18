import { PickSlot, PickSlotChip } from '../pick-slot';

/**
 * The `.scope(…)` picker row every boolean-writing dialog shares (extrude,
 * revolve, sweep, loft): a multi-chip PickSlot listing the solids the
 * feature's add/remove operation is narrowed to, hidden outright while the
 * operation is New — `.new()` builds a separate body, there is no boolean to
 * scope. Clicking anywhere in the slot arms it (whole-solid picking takes
 * over the viewport); the service owns the choices and repaints the chips.
 *
 * The PickSlot mounts on an inner div: its constructor styles its host, and
 * the visibility toggle needs a wrapper of its own (the extrude face-slot
 * idiom).
 */
export class ScopeSlotControl {
  /** The chip at `index` was removed (its ✕). */
  onRemove?: (index: number) => void;
  /** The slot was clicked — arm whole-solid picking. */
  onArm?: () => void;

  private slot: PickSlot;

  constructor(private host: HTMLElement) {
    // A rule above sets the section apart from the feature's own options —
    // inside the host, so the New-op visibility toggle hides both. The gap
    // matches the dialog body's own row spacing.
    this.host.classList.add('flex', 'flex-col', 'gap-3.5');
    const separator = document.createElement('div');
    separator.className = 'border-t border-base-content/10';
    this.host.appendChild(separator);
    const mount = document.createElement('div');
    this.host.appendChild(mount);
    this.slot = new PickSlot(mount, { label: 'Scope', multiple: true });
    this.slot.onRemove = (index) => this.onRemove?.(index);
    this.slot.onArm = () => this.onArm?.();
    this.setChips([]);
  }

  /**
   * Repaint the chips; the prompt tracks whether anything is chosen. The
   * empty state reads as the default value — the boolean runs against All
   * intersecting objects until picks narrow it.
   */
  setChips(chips: PickSlotChip[]): void {
    this.slot.setChips(chips);
    this.slot.setPrompt(chips.length > 0
      ? 'Pick more solids, or leave as is'
      : 'All');
  }

  /** The primary border: solid picks land here while armed. */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** Hidden while the operation is New (a separate body has no boolean). */
  setVisible(visible: boolean): void {
    // `.flex` outranks `.hidden` in the stylesheet — toggle both (the
    // extrude panel's distance-wrap idiom).
    this.host.classList.toggle('hidden', !visible);
    this.host.classList.toggle('flex', visible);
  }

  get visible(): boolean {
    return !this.host.classList.contains('hidden');
  }
}
