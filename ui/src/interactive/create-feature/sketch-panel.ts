import { PanelShell } from './panel-controls';
import { PickSlot } from '../pick-slot';

/**
 * The sketch dialog: a single face/plane pick slot and a Cancel button —
 * picking IS the action (the first pick writes the sketch statement and
 * enters the sketch), so there is nothing to Apply. The dialog stays docked
 * for the whole session of the sketch it started, showing the picked target
 * as a chip; the chip's ✕ exits the sketch-mode view (free camera, grid
 * restored) so a different face/plane can be picked, which moves the sketch
 * statement onto it in place. Cancel deletes the sketch statement from the
 * code outright. Pure DOM — the modify-pick service owns picking, the
 * session, and the applies.
 */
export class SketchStartPanel {
  /** The chip's ✕ — leave the sketch view and re-arm picking. */
  onClear?: () => void;
  /** The Cancel button — delete the sketch statement and close. */
  onCancel?: () => void;
  /** Escape pressed inside the dialog — cancel the re-pick / close. */
  onEscape?: () => void;

  private shell: PanelShell;
  private slot: PickSlot;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-sketch-panel', 'Sketch', '/icons/sketch.png');
    this.shell.onEscape = () => this.onEscape?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="target-slot"></div>
      <div class="flex items-center pt-1">
        <button data-role="cancel" class="btn btn-ghost btn-sm flex-1"
          title="Remove the sketch from the code and close">Cancel</button>
      </div>
    `);
    this.slot = new PickSlot(
      this.shell.body.querySelector('[data-role="target-slot"]')!,
      { label: 'Face / Plane', multiple: false },
    );
    this.slot.onRemove = () => this.onClear?.();
    this.shell.body.querySelector('[data-role="cancel"]')!
      .addEventListener('click', () => this.onCancel?.());
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(): void {
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /** Armed pick state: the empty slot wears the prompt and the active tint. */
  setPicking(prompt: string): void {
    this.slot.setChips([]);
    this.slot.setPrompt(prompt);
    this.slot.setArmed(true);
  }

  /** Tracking state: the picked target as a removable chip. */
  setTarget(label: string): void {
    this.slot.setChips([{ label, badge: '●', removable: true }]);
    this.slot.setPrompt(null);
    this.slot.setArmed(false);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }
}
