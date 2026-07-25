import { keepChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';

/** A picked-entity slot's state, `keep` included (edit mode only). */
export type EntitySlotSelection = { kind: 'picked' } | { kind: 'keep' };

/**
 * The single picked-entity slot the face-consuming dialogs share (extrude's
 * up-to-face target, wrap's target face, helix's cylindrical face): one chip
 * for the pick the service owns, the edited statement's own target as a
 * "Current: …" keep chip, or the pick prompt. The panel owns arming policy;
 * the service owns the entity and pushes/clears the chip label.
 */
export class EntitySlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** The picked chip's ✕ — the service owns the entity. */
  onRemove?: () => void;

  private readonly slot: PickSlot;
  private readonly prompt: string;
  /** Picked chip label (the service owns the entity), or null. */
  private pickedLabel: string | null = null;
  /** Edit mode: the statement's own target text; null when it has none. */
  private keepLabel: string | null = null;

  constructor(host: HTMLElement, opts: { label: string; prompt: string }) {
    this.prompt = opts.prompt;
    this.slot = new PickSlot(host, { label: opts.label, multiple: false });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => this.onRemove?.();
    this.render();
  }

  /** Fresh create-mode arming: no keep, no pick, the prompt. */
  reset(): void {
    this.keepLabel = null;
    this.pickedLabel = null;
    this.render();
  }

  /**
   * Seed the edited statement's own target (edit mode); null or '' means the
   * statement carries none.
   */
  seedKeep(label: string | null): void {
    this.keepLabel = label || null;
    this.pickedLabel = null;
    this.render();
  }

  /**
   * The picked chip (the service owns the entity); null clears it — back to
   * the statement's own target (edit mode), else the prompt.
   */
  setChip(label: string | null): void {
    this.pickedLabel = label;
    this.render();
  }

  selection(): EntitySlotSelection | null {
    if (this.pickedLabel !== null) {
      return { kind: 'picked' };
    }
    if (this.keepLabel !== null) {
      return { kind: 'keep' };
    }
    return null;
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  private render(): void {
    if (this.pickedLabel !== null) {
      this.slot.setChips([{ label: this.pickedLabel, badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else if (this.keepLabel !== null) {
      this.slot.setChips([keepChip(this.keepLabel)]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips([]);
      this.slot.setPrompt(this.prompt);
    }
  }
}
