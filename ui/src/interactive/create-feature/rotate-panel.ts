import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { AxisOption } from './axis-options';
import { AxisSelection, AxisSlotControl } from './axis-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type RotateArmedSlot = 'targets' | 'axis';

/** How the turned bodies land: moved (the default), or left as copies. */
export type RotateMode = 'move' | 'copy';

/** Validated form values, or the message to show when a field is invalid. */
export type RotateValues =
  | {
      mode: RotateMode;
      /** The rotation angle in degrees. */
      angle: ValueExpr;
      newVariables?: NewVariable[];
    }
  | { error: string };

/**
 * The rotate dialog: a Move / Copy tab row (whether the originals stay — the
 * statement's `true` third argument), the solids slot — filled from
 * whole-solid viewport picks (any face or edge click selects the owning
 * solid) or timeline rows, one numbered chip per solid being rotated — the
 * axis slot with its X/Y/Z quick buttons (a world axis, an `axis()`
 * statement, or a picked straight edge — the revolve axis's exact picker),
 * and the angle field. Exactly one slot is ARMED at a time — clicked to
 * activate, marked by the primary border — and the viewer's pick channels
 * follow it: the armed Solids slot takes whole-shape picks, the armed Axis
 * slot takes axis lines and solid edges. Pure DOM + form state — the service
 * owns scene data, the picked entities, previews, and the apply call.
 */
export class RotatePanel extends FeaturePanel {
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** The axis slot left edge mode (✕, a standard/axis pick) — drop the entity. */
  onAxisModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: RotateArmedSlot = 'targets';

  private tabs: ChoiceTabs<RotateMode>;
  private targetsSlot: PickSlot;
  private axisSlot: AxisSlotControl;
  private angleField: ExpressionField;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-rotate-panel',
      title: 'Rotate',
      icon: '/icons/rotate.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="targets-slot"></div>
        <div class="flex flex-col gap-1.5">
          <div data-role="axis-slot"></div>
          <div data-role="axis-buttons" class="join w-full"></div>
        </div>
        <label class="flex flex-col gap-1.5" title="How far the solids turn around the axis, in degrees">
          <span class="text-base-content/70">Angle (°)</span>
          <input data-role="angle" type="number" step="5" value="90"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
      `,
    });

    this.tabs = new ChoiceTabs<RotateMode>(this.role('tabs'), [
      { key: 'move', label: 'Move', title: 'Turn the solids in place — rotate(axis, angle, …)' },
      { key: 'copy', label: 'Copy', title: 'Keep the originals and add turned copies — rotate(axis, angle, true, …)' },
    ], 'move');
    this.tabs.onChange = () => this.onChange?.();

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Solids', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.axisSlot = new AxisSlotControl(
      this.role('axis-slot'),
      this.role('axis-buttons'),
      { buttonTitle: (axis) => `Rotate around the world ${axis} axis` },
    );
    this.axisSlot.onArm = () => this.armSlot('axis');
    this.axisSlot.onModeChange = () => this.onAxisModeChange?.();
    this.axisSlot.onChange = () => this.onChange?.();

    this.angleField = this.enhance('angle');
  }

  /** The variables the angle field's dropdown offers. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.angleField.setVariables(variables);
  }

  show(): void {
    // A fresh arming starts from defaults and empty slots — the previous
    // session's choices would otherwise be revived by source-line matching.
    // The axis opens on the world Z default, a pick replacing it.
    this.shell.setTitle(null);
    this.tabs.setValue('move');
    this.axisSlot.reset();
    this.axisSlot.selectStandard('z');
    this.angleField.setValue(90);
    this.setTargets([]);
    // The empty solids list is the first thing to fill — its slot opens
    // armed, taking whole-shape picks right away.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The axis slot
   * starts on a "Current: …" chip keeping the statement's own expression
   * verbatim (a world-axis literal reads as the standard selection itself);
   * re-sourcing is live and a re-picked chip's ✕ reverts to the kept
   * expression. The targets slot is seeded by the service.
   */
  showEdit(state: {
    mode: RotateMode;
    angle: ValueExpr;
    /** Keep-chip label for the statement's rotation axis. */
    axisLabel: string;
  }): void {
    this.shell.setTitle('Edit rotate');
    this.tabs.setValue(state.mode);
    this.axisSlot.seedKeep(state.axisLabel);
    this.angleField.setValue(state.angle);
    this.setTargets([]);
    // The targets list is the seeded statement's — its slot opens armed like
    // create mode, ready to toggle solids in the viewport.
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Refresh the offered axis statements after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that vanished
   * falls back to the statement's own axis in edit mode, or to the pick
   * prompt.
   */
  setOptions(axes: AxisOption[]): void {
    this.axisSlot.setOptions(axes);
  }

  /** Render the target chips — numbered, the rotate's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick solids in the viewport');
  }

  axisSelection(): AxisSelection | null {
    return this.axisSlot.selection;
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

  values(): RotateValues {
    const angle = this.angleField.read();
    if ('error' in angle) {
      return { error: angle.error === 'empty' ? 'Enter a rotation angle in degrees.' : angle.error };
    }
    if (typeof angle.value === 'number' && angle.value === 0) {
      return { error: 'Enter a nonzero rotation angle in degrees.' };
    }
    return {
      mode: this.tabs.value,
      angle: angle.value,
      newVariables: collectNewVariables([angle]),
    };
  }

  /**
   * Arm one slot: it wears the primary border and the viewer's pick channels
   * follow it. The service re-aims the channels on every actual change.
   */
  armSlot(slot: RotateArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.axisSlot.setArmed(slot === 'axis');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
