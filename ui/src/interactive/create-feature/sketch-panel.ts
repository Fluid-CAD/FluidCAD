import { PanelShell } from './panel-controls';
import { PickSlot } from '../pick-slot';

/** How the dialog opened — see {@link SketchStartPanel.setMode}. */
export type SketchPanelMode = 'create' | 'adopted' | 'edit';

/**
 * The sketch dialog: a single face/plane pick slot and a close button —
 * picking IS the action (the first pick writes the sketch statement and
 * enters the sketch), so there is nothing to Apply. The dialog stays docked
 * for the whole session of the sketch it started, showing the picked target
 * as a chip; the chip's ✕ exits the sketch-mode view (free camera, grid
 * restored) so a different face/plane can be picked, which moves the sketch
 * statement onto it in place. The close button deletes the sketch statement
 * only when this dialog wrote it — see {@link SketchStartPanel.setMode}.
 * Pure DOM — the modify-pick service owns picking, the session, and the
 * applies.
 */
export class SketchStartPanel {
  /** The chip's ✕ — leave the sketch view and re-arm picking. */
  onClear?: () => void;
  /** The close button — Cancel (delete the sketch) or Exit, per the mode. */
  onCancel?: () => void;
  /** Escape pressed inside the dialog — cancel the re-pick / close. */
  onEscape?: () => void;
  /** The section-view toggle — clip the scene at the sketch plane. */
  onSectionViewToggle?: (enabled: boolean) => void;
  /** The snap-to-vertices toggle — snapping while drawing/dragging. */
  onSnapVerticesToggle?: (enabled: boolean) => void;
  /** The snap-to-grid toggle — snapping while drawing/dragging. */
  onSnapGridToggle?: (enabled: boolean) => void;

  private shell: PanelShell;
  private slot: PickSlot;
  private closeBtn: HTMLButtonElement;
  private sketchOptionsWrap: HTMLDivElement;
  private sectionViewInput: HTMLInputElement;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-sketch-panel', 'Sketch', '/icons/sketch.png');
    this.shell.onEscape = () => this.onEscape?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="target-slot"></div>
      <div data-role="sketch-options" class="hidden flex-col gap-2">
        <label class="flex items-center justify-between cursor-pointer"
          title="Clip away everything in front of the sketch plane">
          <span class="text-base-content/70">Section view</span>
          <input data-role="section-view" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Snap to existing sketch vertices while drawing and dragging">
          <span class="text-base-content/70">Snap to vertices</span>
          <input data-role="snap-vertices" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Snap to the grid while drawing and dragging">
          <span class="text-base-content/70">Snap to grid</span>
          <input data-role="snap-grid" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
        </label>
      </div>
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
    this.closeBtn = this.shell.body.querySelector('[data-role="cancel"]')!;
    this.closeBtn.addEventListener('click', () => this.onCancel?.());
    this.sketchOptionsWrap = this.shell.body.querySelector('[data-role="sketch-options"]')!;
    this.sectionViewInput = this.shell.body.querySelector('[data-role="section-view"]')!;
    this.sectionViewInput.addEventListener('change', () => {
      this.onSectionViewToggle?.(this.sectionViewInput.checked);
    });
    const snapVerticesInput = this.shell.body.querySelector('[data-role="snap-vertices"]') as HTMLInputElement;
    snapVerticesInput.addEventListener('change', () => {
      this.onSnapVerticesToggle?.(snapVerticesInput.checked);
    });
    const snapGridInput = this.shell.body.querySelector('[data-role="snap-grid"]') as HTMLInputElement;
    snapGridInput.addEventListener('change', () => {
      this.onSnapGridToggle?.(snapGridInput.checked);
    });
  }

  /**
   * The options block (section view + snap toggles) only means something once
   * the sketch plane exists, so the viewer drives it from the scene: shown
   * while a sketch is active — including one whose face/plane is being
   * re-picked, where the camera leaves the sketch view but the sketch (and
   * this dialog) stay — and hidden once the scene has no sketch left.
   */
  setSectionViewVisible(visible: boolean): void {
    this.sketchOptionsWrap.classList.toggle('hidden', !visible);
    this.sketchOptionsWrap.classList.toggle('flex', visible);
  }

  setSectionViewActive(active: boolean): void {
    this.sectionViewInput.checked = active;
  }

  /**
   * How the dialog opened, which is what its close button means:
   * - `create` — this dialog wrote the sketch statement, so Cancel undoes it
   *   by deleting the statement again.
   * - `adopted` — the scene merely ended in a sketch (a page reload, a sketch
   *   entered by editing code); there is nothing to undo, so Exit just closes.
   * - `edit` — a timeline double-click opened the dialog over an existing
   *   sketch; it wears the edit title and the same non-destructive Exit every
   *   other edit dialog closes with.
   */
  setMode(mode: SketchPanelMode): void {
    this.shell.setTitle(mode === 'edit' ? 'Edit sketch' : null);
    // The close button is a Cancel that deletes the sketch this dialog wrote,
    // so it only makes sense in 'create' mode. In the adopted/edit modes there
    // is nothing to cancel, so the button is hidden entirely — Escape or the
    // Sketch toggle still closes the dialog.
    const isCreate = mode === 'create';
    this.closeBtn.textContent = 'Cancel';
    this.closeBtn.title = 'Remove the sketch from the code and close';
    this.closeBtn.parentElement!.classList.toggle('hidden', !isCreate);
  }

  // The dialog's logical visibility (what the session wants) is tracked
  // separately from the DOM: while suspended — another sketch-mode dialog
  // (the 2D fillet panel) occupies the docked spot — show() only records
  // intent, and lifting the suspension restores whatever state the session
  // moved to in the meantime.
  private logicalVisible = false;
  private suspended = false;

  get isVisible(): boolean {
    return this.logicalVisible;
  }

  show(): void {
    this.logicalVisible = true;
    if (!this.suspended) {
      this.shell.show();
    }
  }

  hide(): void {
    this.logicalVisible = false;
    this.shell.hide();
  }

  /** Step aside for (or return from) a dialog sharing the docked spot. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) {
      return;
    }
    this.suspended = suspended;
    if (suspended) {
      this.shell.hide();
    } else if (this.logicalVisible) {
      this.shell.show();
    }
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
