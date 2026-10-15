import { FeaturePanel } from './feature-panel';
import { ChoiceTabs } from './panel-controls';
import { PlaneOption } from './plane-bases';
import { PlaneSelection, PlaneSlotControl } from './plane-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, SplitKeepSide, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';
import { iconUrl } from '../../ui/icon-url';

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type SplitArmedSlot = 'targets' | 'plane';

/** Validated form values, or the message to show when a field is invalid. */
export type SplitValues =
  | {
      /** The pieces the split keeps. */
      keep: SplitKeepSide;
      /** The plane offset along its normal; null when the field is empty. */
      offset: ValueExpr | null;
      newVariables?: NewVariable[];
    }
  | { error: string };

/**
 * The split dialog: a Both / Front / Back tab row (which pieces stay — the
 * normal side is "front"), the cut slot — an origin-plane quad, a plane
 * feature, a picked planar face, or a sketched line picked in the viewport
 * (the plane it would sweep out of its sketch) — the solids slot, filled
 * from whole-solid viewport picks or timeline rows and left empty to split
 * every solid in scope, and the offset field. Exactly one slot is ARMED at a
 * time — clicked to activate, marked by the primary border — and the
 * viewer's pick channels follow it. Pure DOM + form state — the service owns
 * scene data, the picked entities, previews, and the apply call.
 */
export class SplitPanel extends FeaturePanel {
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** The cut slot left face / sketch-line mode (✕, a standard/plane pick) — drop the pick. */
  onPlaneModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: SplitArmedSlot = 'plane';

  private tabs: ChoiceTabs<SplitKeepSide>;
  private targetsSlot: PickSlot;
  private planeSlot: PlaneSlotControl;
  private offsetField: ExpressionField;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-split-panel',
      title: 'Split',
      icon: iconUrl('split'),
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="plane-slot"></div>
        <div data-role="targets-slot"></div>
        <label class="flex flex-col gap-1.5" title="Move the cut plane along its normal before cutting; empty cuts at the plane itself">
          <span class="text-base-content/70">Offset</span>
          <input data-role="offset" type="number" step="1" placeholder="0"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
      `,
    });

    this.tabs = new ChoiceTabs<SplitKeepSide>(this.role('tabs'), [
      { key: 'both', label: 'Both', title: 'Keep the pieces on both sides — split(plane, …)' },
      { key: 'front', label: 'Front', title: "Keep the pieces on the side the plane normal points to — { keep: 'front' }" },
      { key: 'back', label: 'Back', title: "Keep the pieces on the other side — { keep: 'back' }" },
    ], 'both');
    this.tabs.onChange = () => this.onChange?.();

    this.planeSlot = new PlaneSlotControl(this.role('plane-slot'), {
      label: 'Cut',
      prompt: 'Pick a plane, face or sketch line',
    });
    this.planeSlot.onArm = () => this.armSlot('plane');
    this.planeSlot.onModeChange = () => this.onPlaneModeChange?.();
    this.planeSlot.onChange = () => this.onChange?.();

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Solids', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.offsetField = this.enhance('offset');
  }

  /** The variables the offset field's dropdown offers. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.offsetField.setVariables(variables);
  }

  show(): void {
    // A fresh arming starts from defaults and empty slots — the previous
    // session's choices would otherwise be revived by source-line matching.
    this.shell.setTitle(null);
    this.tabs.setValue('both');
    this.planeSlot.reset();
    this.offsetField.setValue('');
    this.setTargets([]);
    // The cut is the one thing a split needs — its slot opens armed, taking
    // planes, faces and sketch lines right away; the solids are optional.
    this.armSlot('plane');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The cut slot
   * starts on a "Current: …" chip keeping the statement's own expression
   * verbatim (an origin-plane literal reads as the standard selection
   * itself); re-sourcing is live and a re-picked chip's ✕ reverts to the
   * kept expression. The targets slot is seeded by the service.
   */
  showEdit(state: {
    keep: SplitKeepSide;
    offset: ValueExpr | null;
    /** Keep-chip label for the statement's cut. */
    planeLabel: string;
  }): void {
    this.shell.setTitle('Edit split');
    this.tabs.setValue(state.keep);
    this.planeSlot.seedKeep(state.planeLabel);
    this.offsetField.setValue(state.offset ?? '');
    this.setTargets([]);
    this.armSlot('targets');
    this.shell.show();
  }

  /**
   * Refresh the offered plane statements after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location — scene ids change every render).
   */
  setOptions(planes: PlaneOption[]): void {
    this.planeSlot.setOptions(planes);
  }

  /** Render the target chips — numbered, the split's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'All solids — or pick the ones to split');
  }

  planeSelection(): PlaneSelection | null {
    return this.planeSlot.selection;
  }

  /**
   * A plane feature picked in 3D or the timeline; arms the cut slot so the
   * border tracks where the pick landed. No change event fires.
   */
  selectPlane(option: PlaneOption): void {
    this.planeSlot.selectOption(option);
    this.armSlot('plane');
  }

  /** An origin-plane quad picked in the viewport. No change event fires. */
  selectStandardPlane(plane: 'xy' | 'xz' | 'yz'): void {
    this.planeSlot.selectStandard(plane);
    this.armSlot('plane');
  }

  /** The cut slot's picked-face chip (the service owns the entity); null clears it. */
  setPlaneFaceChip(label: string | null): void {
    this.planeSlot.setFaceChip(label);
  }

  /** The cut slot's picked sketch-line chip (the service owns the pick); null clears it. */
  setSketchLineChip(label: string | null): void {
    this.planeSlot.setSketchLineChip(label);
  }

  values(): SplitValues {
    const offset = this.offsetField.read();
    if ('error' in offset) {
      if (offset.error !== 'empty') {
        return { error: offset.error };
      }
      return { keep: this.tabs.value, offset: null };
    }
    return {
      keep: this.tabs.value,
      offset: typeof offset.value === 'number' && offset.value === 0 ? null : offset.value,
      newVariables: collectNewVariables([offset]),
    };
  }

  /**
   * Arm one slot: it wears the primary border and the viewer's pick channels
   * follow it. The service re-aims the channels on every actual change.
   */
  armSlot(slot: SplitArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.planeSlot.setArmed(slot === 'plane');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
