import { OpTabs } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption } from './sketch-profiles';
import { SketchSlotControl, SketchSlotSelection } from './sketch-slot';
import { EntitySlotControl, EntitySlotSelection } from './entity-slot';
import { WrapOptionValues } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type WrapValues = WrapOptionValues | { error: string };

export type WrapSketchSelection = SketchSlotSelection;

/**
 * The wrap dialog: operation tabs (emboss / deboss / standalone pad), the
 * pad thickness, the sketch pick slot (a single chip — filled by clicking a
 * sketch in the timeline or its wires in 3D) and the target face pick slot
 * (a single face picked in the 3D view — face picking is live the whole time
 * the dialog is armed). Pure DOM + form state — the service owns scene data,
 * the picked face entity, previews, and the apply call.
 */
export class WrapPanel extends FeaturePanel {
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private tabs: OpTabs;
  private thicknessField: ExpressionField;
  private sketchSlot: SketchSlotControl;
  private faceSlot: EntitySlotControl;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-wrap-panel',
      title: 'Wrap',
      icon: '/icons/wrap.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="sketch-slot"></div>
        <div data-role="face-slot"></div>
        <label class="flex flex-col gap-1.5"
          title="Pad thickness measured along the surface normal">
          <span class="text-base-content/70">Thickness</span>
          <input data-role="thickness" type="number" step="0.5" min="0.05" value="1"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Emboss — raise the wrapped sketch from the face — wrap()' },
      { op: 'remove', label: 'Remove', title: 'Deboss — sink the wrapped sketch into the face — wrap().remove()' },
      { op: 'new', label: 'New', title: 'Keep the wrapped pad as a separate body — wrap().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();

    this.sketchSlot = new SketchSlotControl(this.role('sketch-slot'));
    this.sketchSlot.onArm = () => this.armSlot('sketch');
    this.sketchSlot.onChange = () => this.onChange?.();
    this.faceSlot = new EntitySlotControl(this.role('face-slot'), {
      label: 'Target face',
      prompt: 'Pick a face',
    });
    this.faceSlot.onArm = () => this.armSlot('face');
    this.faceSlot.onRemove = () => this.onRemoveFace?.();

    this.thicknessField = this.enhance('thickness');
  }

  show(options: SketchProfileOption[]): void {
    // A fresh arming starts from defaults — the previous session's slot
    // choices would otherwise be revived by source-line matching. The sketch
    // opens on the first offered one (the active one, in sketch mode).
    this.faceSlot.reset();
    this.shell.setTitle(null);
    this.sketchSlot.reset(options);
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
    this.sketchSlot.seedKeep(state.sketchLabel);
    this.faceSlot.seedKeep(state.faceLabel);
    this.shell.setTitle('Edit wrap');
    this.tabs.setOp(state.op);
    this.thicknessField.setValue(state.thickness);
    this.armSlot('face');
    this.shell.show();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered (matched by kind + source
   * location). A choice that vanished falls back to the "Current: …" chip
   * in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    this.sketchSlot.setOptions(options);
  }

  selectedSketch(): SketchProfileOption | null {
    return this.sketchSlot.selectedOption();
  }

  /** The sketch slot's state, `keep` included (edit mode only). */
  sketchSelection(): WrapSketchSelection | null {
    return this.sketchSlot.selection();
  }

  /**
   * A timeline/wire sketch pick. Returns false when the sketch isn't among
   * the offered options.
   */
  selectSketch(filePath: string, line: number): boolean {
    if (!this.sketchSlot.selectByLocation(filePath, line)) {
      return false;
    }
    this.armSlot('sketch');
    return true;
  }

  /**
   * The face slot's picked chip (the service owns the entity); null clears
   * it — back to the statement's own target (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.faceSlot.setChip(label);
    // A landed 3D pick moves the active state onto the face slot; clears
    // (✕, stale resets) leave whichever slot the user was working with.
    if (label !== null) {
      this.armSlot('face');
    }
  }

  /** The face slot's state, `keep` included (edit mode only). */
  faceSelection(): EntitySlotSelection | null {
    return this.faceSlot.selection();
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

  /** Move the active (armed) state onto one slot exclusively. */
  private armSlot(slot: 'sketch' | 'face'): void {
    this.sketchSlot.setArmed(slot === 'sketch');
    this.faceSlot.setArmed(slot === 'face');
  }
}
