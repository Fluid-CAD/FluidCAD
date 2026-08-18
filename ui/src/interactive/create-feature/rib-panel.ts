import { OpTabs } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption } from './sketch-profiles';
import { SketchSlotControl, SketchSlotSelection } from './sketch-slot';
import { ScopeSlotControl } from './scope-slot';
import { PickSlotChip } from '../pick-slot';
import { RibOptionValues, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type RibValues = RibOptionValues | { error: string };

/**
 * The rib dialog: an Add / Remove / New tab row (the boolean operation), the
 * spine pick slot (a single chip — filled by clicking a sketch in the
 * timeline or its wires in 3D), the signed thickness (the sign picks the
 * side of the sketch plane the rib grows from), the parallel and extend
 * toggles, a draft angle, and the scope slot — the solids the rib conforms
 * to and fuses with, picked whole in the viewport or by their timeline rows
 * (empty means the whole scene). Pure DOM + form state — the service owns
 * scene data, previews, and the apply call.
 */
export class RibPanel extends FeaturePanel {
  /** The scope chip at `index` was removed. */
  onRemoveScope?: (index: number) => void;

  private tabs: OpTabs;
  private spineSlot: SketchSlotControl;
  private scopeSlot: ScopeSlotControl;
  private thicknessField: ExpressionField;
  private draftField: ExpressionField;
  private parallelCheckbox: HTMLInputElement;
  private extendCheckbox: HTMLInputElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-rib-panel',
      title: 'Rib',
      icon: '/icons/rib.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="spine-slot"></div>
        <label class="flex flex-col gap-1.5"
          title="Wall thickness, centered on the spine — the sign picks which side of the sketch plane the rib grows from">
          <span class="text-base-content/70">Thickness</span>
          <input data-role="thickness" type="number" step="0.5" value="5"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Extrude in-plane, perpendicular to the spine — the sketch line becomes one face of the wall">
          <span class="text-base-content/70">Parallel to sketch plane</span>
          <input data-role="parallel" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Push the wall's endpoints outward until they blend into the surrounding walls">
          <span class="text-base-content/70">Extend to walls</span>
          <input data-role="extend" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
        <label class="flex flex-col gap-1.5"
          title="Taper the rib walls — positive narrows toward the tip, negative widens; 0 is straight">
          <span class="text-base-content/70">Draft angle (°)</span>
          <input data-role="draft" type="number" step="0.5" value="0"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div data-role="scope-slot"></div>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the rib with the surrounding solids — rib()' },
      { op: 'remove', label: 'Remove', title: 'Cut the rib shape out of the model — rib().remove()' },
      { op: 'new', label: 'New', title: 'Keep the rib as a separate body — rib().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();

    this.spineSlot = new SketchSlotControl(this.role('spine-slot'), { label: 'Spine sketch' });
    this.spineSlot.onChange = () => this.onChange?.();

    this.scopeSlot = new ScopeSlotControl(this.role('scope-slot'));
    // The slot is a live pick target the whole time the dialog is up — solid
    // clicks land here, sketch-wire clicks in the spine slot.
    this.scopeSlot.setArmed(true);
    this.scopeSlot.onRemove = (index) => this.onRemoveScope?.(index);

    this.parallelCheckbox = this.role('parallel');
    this.extendCheckbox = this.role('extend');
    this.parallelCheckbox.addEventListener('change', () => this.onChange?.());
    this.extendCheckbox.addEventListener('change', () => this.onChange?.());
    this.thicknessField = this.enhance('thickness');
    this.draftField = this.enhance('draft');
  }

  /** The variables the fields' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.thicknessField.setVariables(variables);
    this.draftField.setVariables(variables);
  }

  show(options: SketchProfileOption[]): void {
    this.shell.setTitle(null);
    this.spineSlot.reset(options);
    this.syncSpineArmed();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The spine slot
   * starts on a "Current: …" chip that keeps the statement's own spine
   * verbatim; picking another sketch re-sources it (its ✕ reverts to the
   * kept spine). The scope chips are the service's — it seeds one kept chip
   * per statement target, toggled and re-picked like create mode.
   */
  showEdit(state: RibOptionValues & { spineLabel: string | null }): void {
    this.spineSlot.seedKeep(state.spineLabel);
    this.syncSpineArmed();
    this.shell.setTitle('Edit rib');
    this.tabs.setOp(state.op);
    this.thicknessField.setValue(state.thickness);
    this.parallelCheckbox.checked = state.parallel;
    this.extendCheckbox.checked = state.extend;
    this.draftField.setValue(state.draft ?? 0);
    this.shell.show();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered. A choice that vanished
   * falls back to the "Current: …" chip in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    this.spineSlot.setOptions(options);
    this.syncSpineArmed();
  }

  selectedOption(): SketchProfileOption | null {
    return this.spineSlot.selectedOption();
  }

  /** The spine slot's state, `keep` included (edit mode only). */
  spineSelection(): SketchSlotSelection | null {
    return this.spineSlot.selection();
  }

  /** Programmatic spine choice (a timeline pick); no change event fires. */
  selectSpine(index: number): void {
    this.spineSlot.selectIndex(index);
  }

  /** The scope chips (the service owns the choices; prompts are the slot's). */
  setScope(chips: PickSlotChip[]): void {
    this.scopeSlot.setChips(chips);
  }

  values(): RibValues {
    const op = this.tabs.op;
    const thicknessRead = this.thicknessField.read();
    if ('error' in thicknessRead
      || (typeof thicknessRead.value === 'number' && thicknessRead.value === 0)) {
      const detail = 'error' in thicknessRead && thicknessRead.error !== 'empty' ? ` ${thicknessRead.error}.` : '';
      return { error: `Enter a nonzero thickness.${detail}` };
    }
    const thickness: ValueExpr = thicknessRead.value;
    const draftRead = this.draftField.read();
    if ('error' in draftRead && draftRead.error !== 'empty') {
      return { error: `Draft angle: ${draftRead.error}.` };
    }
    const draft = 'error' in draftRead ? 0 : draftRead.value;
    const reads = [thicknessRead, draftRead];
    return {
      op,
      thickness,
      parallel: this.parallelCheckbox.checked,
      extend: this.extendCheckbox.checked,
      draft: draft === 0 ? null : draft,
      newVariables: collectNewVariables(reads.map(r => r && !('error' in r) ? r : null)),
    };
  }

  /** The slot is the live pick target whenever there is anything to pick. */
  private syncSpineArmed(): void {
    this.spineSlot.setArmed(this.spineSlot.editMode || this.spineSlot.options.length > 0);
  }
}
