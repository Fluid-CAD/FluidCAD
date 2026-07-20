import { OpTabs, PanelShell } from './panel-controls';
import { SketchProfileOption, keepSketchChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';
import { WrapOptionValues } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type WrapValues = WrapOptionValues | { error: string };

export type WrapSketchSelection =
  | { kind: 'sketch'; option: SketchProfileOption }
  /** Edit mode only: the statement's own sketch expression stays. */
  | { kind: 'keep' };

/** The sketch slot's internal state; `null` is the empty pick prompt. */
type SketchState =
  | { kind: 'keep' }
  | { kind: 'sketch'; option: SketchProfileOption }
  | null;

/**
 * The wrap dialog: operation tabs (emboss / deboss / standalone pad), the
 * pad thickness, the sketch pick slot (a single chip — filled by clicking a
 * sketch in the timeline or its wires in 3D) and the target face pick slot
 * (a single face picked in the 3D view — face picking is live the whole time
 * the dialog is armed). Pure DOM + form state — the service owns scene data,
 * the picked face entity, previews, and the apply call.
 */
export class WrapPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private shell: PanelShell;
  private tabs: OpTabs;
  private thicknessInput: HTMLInputElement;
  private thicknessField: ExpressionField;
  private sketchSlot: PickSlot;
  private faceSlot: PickSlot;
  private applyBtn: HTMLButtonElement;
  private options: SketchProfileOption[] = [];
  private sketchState: SketchState = null;
  /** Picked-face chip label (the service owns the entity), or null. */
  private pickedFaceLabel: string | null = null;
  /** Edit mode: both slots start on "Current: …" chips. */
  private editMode = false;
  private keepSketchLabel = '';
  private keepFaceLabel = '';

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-wrap-panel', 'Wrap', '/icons/wrap.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <div data-role="sketch-slot"></div>
      <div data-role="face-slot"></div>
      <label class="flex flex-col gap-1.5"
        title="Pad thickness measured along the surface normal">
        <span class="text-base-content/70">Thickness</span>
        <input data-role="thickness" type="number" step="0.5" min="0.05" value="1"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Emboss — raise the wrapped sketch from the face — wrap()' },
      { op: 'remove', label: 'Remove', title: 'Deboss — sink the wrapped sketch into the face — wrap().remove()' },
      { op: 'new', label: 'New', title: 'Keep the wrapped pad as a separate body — wrap().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();

    this.sketchSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="sketch-slot"]')!,
      { label: 'Sketch', multiple: false },
    );
    this.faceSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="face-slot"]')!,
      { label: 'Target face', multiple: false },
    );
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;
    this.thicknessInput = this.shell.body.querySelector('[data-role="thickness"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    // The field owns the thickness input's keyboard handling (variable
    // dropdown, Enter-to-apply) and flips it to type="text" for identifiers.
    this.thicknessField = new ExpressionField(this.thicknessInput);
    this.thicknessField.onSubmit = () => this.onApply?.();
    this.thicknessInput.addEventListener('input', () => this.onChange?.());
    this.sketchSlot.onArm = () => this.armSlot('sketch');
    this.faceSlot.onArm = () => this.armSlot('face');
    this.sketchSlot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own sketch (a re-pick is undone, never the sketch itself).
      this.sketchState = this.editMode ? { kind: 'keep' } : null;
      this.renderSketch();
      this.onChange?.();
    };
    this.faceSlot.onRemove = () => this.onRemoveFace?.();
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's slot
    // choices would otherwise be revived by source-line matching. The sketch
    // opens on the first offered one (the active one, in sketch mode).
    this.sketchState = null;
    this.editMode = false;
    this.keepSketchLabel = '';
    this.keepFaceLabel = '';
    this.setFaceChip(null);
    this.shell.setTitle(null);
    this.setOptions(options);
    if (this.sketchState === null && options.length > 0) {
      this.sketchState = { kind: 'sketch', option: options[0] };
      this.renderSketch();
    }
    // The face slot opens empty and awaiting a pick — it starts armed.
    this.armSlot('face');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). Both slots start
   * on a "Current: …" chip that keeps the statement's own expression
   * verbatim; picking another sketch (or a face, for the target) re-sources
   * that slot, and its ✕ reverts to the kept expression. The op tabs and
   * thickness edit in place.
   */
  showEdit(state: WrapOptionValues & { sketchLabel: string; faceLabel: string }): void {
    this.options = [];
    this.sketchState = { kind: 'keep' };
    this.editMode = true;
    this.keepSketchLabel = state.sketchLabel;
    this.keepFaceLabel = state.faceLabel;
    this.shell.setTitle('Edit wrap');
    this.tabs.setOp(state.op);
    this.thicknessField.setValue(state.thickness);
    this.setFaceChip(null);
    this.renderSketch();
    this.armSlot('face');
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location). A choice that vanished falls back to the "Current: …" chip
   * in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    this.options = options;
    if (this.sketchState?.kind === 'sketch') {
      const prev = this.sketchState.option;
      const match = options.find(o => o.kind === prev.kind
        && (o.kind === 'active' || (o.filePath === prev.filePath && o.line === prev.line)));
      this.sketchState = match ? { kind: 'sketch', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    this.renderSketch();
  }

  selectedSketch(): SketchProfileOption | null {
    const selection = this.sketchSelection();
    return selection?.kind === 'sketch' ? selection.option : null;
  }

  /** The sketch slot's state, `keep` included (edit mode only). */
  sketchSelection(): WrapSketchSelection | null {
    return this.sketchState;
  }

  /**
   * A timeline/wire sketch pick. Returns false when the sketch isn't among
   * the offered options.
   */
  selectSketch(filePath: string, line: number): boolean {
    const option = this.options.find(o => o.filePath === filePath && o.line === line);
    if (!option) {
      return false;
    }
    this.sketchState = { kind: 'sketch', option };
    this.renderSketch();
    this.armSlot('sketch');
    return true;
  }

  /**
   * The face slot's picked chip (the service owns the entity); null clears
   * it — back to the statement's own target (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.pickedFaceLabel = label;
    if (label !== null) {
      this.faceSlot.setChips([{ label, badge: '●', removable: true }]);
      this.faceSlot.setPrompt(null);
    } else if (this.editMode && this.keepFaceLabel) {
      // Edit mode: the statement's own target — a re-pick is undone by ✕,
      // never the target itself (the extrude keep-chip contract).
      this.faceSlot.setChips([{
        label: `Current: ${this.keepFaceLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.faceSlot.setPrompt(null);
    } else {
      this.faceSlot.setChips([]);
      this.faceSlot.setPrompt('Pick a face');
    }
    // A landed 3D pick moves the active state onto the face slot; clears
    // (✕, stale resets) leave whichever slot the user was working with.
    if (label !== null) {
      this.armSlot('face');
    }
  }

  /** The face slot's state, `keep` included (edit mode only). */
  faceSelection(): { kind: 'picked' } | { kind: 'keep' } | null {
    if (this.pickedFaceLabel !== null) {
      return { kind: 'picked' };
    }
    if (this.editMode && this.keepFaceLabel) {
      return { kind: 'keep' };
    }
    return null;
  }

  values(): WrapValues {
    const read = this.thicknessField.read();
    if ('error' in read || (typeof read.value === 'number' && read.value <= 0)) {
      const detail = 'error' in read && read.error !== 'empty' ? ` ${read.error}.` : '';
      return { error: `Enter a positive pad thickness.${detail}` };
    }
    return { op: this.tabs.op, thickness: read.value, newVariables: collectNewVariables([read]) };
  }

  /** The variables the thickness field's dropdown offers. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.thicknessField.setVariables(variables);
  }

  setPreview(text: string | null): void {
    this.shell.setPreview(text);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  /** The sketch slot: one chip (the chosen sketch), or the pick prompt. */
  private renderSketch(): void {
    const state = this.sketchState;
    if (state?.kind === 'keep') {
      this.sketchSlot.setChips([keepSketchChip(this.keepSketchLabel)]);
      this.sketchSlot.setPrompt(null);
    } else {
      this.sketchSlot.setChips(state?.kind === 'sketch'
        ? [sourceChip(state.option, { badge: '●', removable: true })]
        : []);
      this.sketchSlot.setPrompt(state
        ? null
        : this.options.length > 0 || this.editMode
          ? 'Pick a sketch'
          : 'No sketch — create one first');
    }
  }

  /** Move the active (armed) state onto one slot exclusively. */
  private armSlot(slot: 'sketch' | 'face'): void {
    this.sketchSlot.setArmed(slot === 'sketch');
    this.faceSlot.setArmed(slot === 'face');
  }
}
