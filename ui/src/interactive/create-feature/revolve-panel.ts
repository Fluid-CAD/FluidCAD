import { OpTabs, ThinControl } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption } from './sketch-profiles';
import { AxisOption } from './axis-options';
import { AxisSelection, AxisSlotControl } from './axis-slot';
import { SketchSlotControl, SketchSlotSelection } from './sketch-slot';
import { RevolveOptionValues, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type RevolveValues = RevolveOptionValues | { error: string };

/** The axis slot's state — the shared axis-picker state machine. */
export type RevolveAxisSelection = AxisSelection;

/**
 * The revolve dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile pick slot (a single chip — filled by clicking a sketch in the
 * timeline or its wires in 3D), the axis pick slot (a single chip — an axis
 * or edge picked in 3D, or one of the X/Y/Z quick buttons under it), the
 * sweep angle in degrees, and a thin() toggle with its thickness. Exactly
 * one slot is ARMED at a time — clicked to activate, marked by the primary
 * border — and 3D picks land only there (the sweep/loft idiom); timeline
 * rows are typed and always route, re-arming their slot. Pure DOM + form
 * state — the service owns scene data, the picked edge entity, previews,
 * and the apply call.
 */
export class RevolvePanel extends FeaturePanel {
  /** The axis slot left edge mode (✕, a standard/axis pick) — drop the entity. */
  onAxisModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot 3D picks land in — the one last clicked. */
  armedSlot: 'profile' | 'axis' = 'axis';

  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: SketchSlotControl;
  private axisSlot: AxisSlotControl;
  private angleField: ExpressionField;
  private symmetricCheckbox: HTMLInputElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-revolve-panel',
      title: 'Revolve',
      icon: '/icons/revolve.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="profile-slot"></div>
        <div class="flex flex-col gap-1.5">
          <div data-role="axis-slot"></div>
          <div data-role="axis-buttons" class="join w-full"></div>
        </div>
        <label class="flex flex-col gap-1.5" title="Sweep angle in degrees — 360 is a full revolution">
          <span class="text-base-content/70">Angle (°)</span>
          <input data-role="angle" type="number" step="5" value="360"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Split the sweep angle equally across both sides of the sketch plane — revolve().symmetric()">
          <span class="text-base-content/70">Symmetric</span>
          <input data-role="symmetric" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
        <div data-role="thin-host" class="contents"></div>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the revolved solid with the model — revolve()' },
      { op: 'remove', label: 'Remove', title: 'Cut the revolved solid out of the model — revolve().remove()' },
      { op: 'new', label: 'New', title: 'Keep the revolved solid as a separate body — revolve().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.role('thin-host'));
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSlot = new SketchSlotControl(this.role('profile-slot'));
    this.profileSlot.onArm = () => this.armSlot('profile');
    this.profileSlot.onChange = () => this.onChange?.();

    this.axisSlot = new AxisSlotControl(this.role('axis-slot'), this.role('axis-buttons'), {
      buttonTitle: (axis) => `Revolve around the world ${axis} axis`,
    });
    this.axisSlot.onArm = () => this.armSlot('axis');
    this.axisSlot.onChange = () => this.onChange?.();
    this.axisSlot.onModeChange = () => this.onAxisModeChange?.();

    this.angleField = this.enhance('angle');
    this.symmetricCheckbox = this.role('symmetric');
    this.symmetricCheckbox.addEventListener('change', () => this.onChange?.());
  }

  /** The variables the fields' dropdowns offer (thin thickness included). */
  setScopeVariables(variables: VariableInfo[]): void {
    this.angleField.setVariables(variables);
    this.thin.setVariables(variables);
  }

  show(profiles: SketchProfileOption[], axes: AxisOption[]): void {
    // A fresh arming starts from defaults — the previous session's choices
    // would otherwise be revived by source-line matching. The profile opens
    // on the first offered sketch (the active one, in sketch mode); the axis
    // on the world Z default, a pick replacing it.
    this.shell.setTitle(null);
    this.angleField.setValue(360);
    this.symmetricCheckbox.checked = false;
    this.profileSlot.reset(profiles);
    this.axisSlot.reset();
    this.axisSlot.setOptions(axes);
    this.axisSlot.selectStandard('z');
    // The profile pre-fills; the axis is the explicit next step.
    this.armSlot('axis');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). Both slots start
   * on a "Current: …" chip that keeps the statement's own expression
   * verbatim; picking another sketch (or an axis/edge/standard axis) re-
   * sources that slot, and its ✕ reverts to the kept expression. The op
   * tabs, angle and thin controls edit in place.
   */
  showEdit(state: RevolveOptionValues & {
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    axisLabel: string;
    profileLabel: string | null;
  }): void {
    this.shell.setTitle('Edit revolve');
    this.tabs.setOp(state.op);
    this.angleField.setValue(state.angle);
    this.symmetricCheckbox.checked = state.symmetric;
    this.thin.setValues(state.thin);
    this.profileSlot.seedKeep(state.profileLabel);
    this.axisSlot.seedKeep(state.axisLabel);
    this.armSlot('axis');
    this.shell.show();
  }

  /**
   * Refresh the offered sketches/axes after a re-render, keeping current
   * choices when the same statement is still offered. A choice that
   * vanished falls back to the "Current: …" chip in edit mode, or to the
   * pick prompt. Standard-axis and picked-edge states are scene-independent
   * and survive as they are (the service re-validates edge picks itself).
   */
  setOptions(profiles: SketchProfileOption[], axes: AxisOption[]): void {
    this.profileSlot.setOptions(profiles);
    this.axisSlot.setOptions(axes);
  }

  selectedProfile(): SketchProfileOption | null {
    return this.profileSlot.selectedOption();
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): SketchSlotSelection | null {
    return this.profileSlot.selection();
  }

  axisSelection(): RevolveAxisSelection | null {
    return this.axisSlot.selection;
  }

  /**
   * Programmatic profile choice (a timeline pick); arms the profile slot so
   * the border tracks where the pick landed. No change event fires.
   */
  selectProfile(index: number): void {
    if (this.profileSlot.selectIndex(index)) {
      this.armSlot('profile');
    }
  }

  /**
   * An axis picked in 3D or the timeline; arms the axis slot so the border
   * tracks where the pick landed. No change event fires.
   */
  selectAxis(option: AxisOption): void {
    this.axisSlot.selectOption(option);
    this.armSlot('axis');
  }

  /**
   * The axis slot's picked-edge chip (the service owns the entity); null
   * clears it — back to the statement's own axis (edit mode), else the
   * prompt.
   */
  setAxisEdgeChip(label: string | null): void {
    this.axisSlot.setEdgeChip(label);
  }

  values(): RevolveValues {
    const angleRead = this.angleField.read();
    if ('error' in angleRead || (typeof angleRead.value === 'number' && angleRead.value === 0)) {
      const detail = 'error' in angleRead && angleRead.error !== 'empty' ? ` ${angleRead.error}.` : '';
      return { error: `Enter a nonzero sweep angle in degrees.${detail}` };
    }
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return {
      op: this.tabs.op,
      angle: angleRead.value,
      symmetric: this.symmetricCheckbox.checked,
      thin: thin.thin,
      newVariables: collectNewVariables([angleRead, thin]),
    };
  }

  /**
   * Arm one slot: it takes the 3D picks and wears the primary border; the
   * other goes quiet. The service re-aims the viewer pick channels on every
   * actual change.
   */
  private armSlot(slot: 'profile' | 'axis'): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.profileSlot.setArmed(slot === 'profile');
    this.axisSlot.setArmed(slot === 'axis');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
