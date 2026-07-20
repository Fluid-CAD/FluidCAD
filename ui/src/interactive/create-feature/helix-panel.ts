import { ChoiceTabs } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { AxisOption } from './axis-options';
import { AxisSelection, AxisSlotControl } from './axis-slot';
import { EntitySlotControl } from './entity-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Which geometry the helix is built around — the two dialog tabs. */
export type HelixSourceMode = 'axis' | 'face';

/** Which coil dimension the dialog specifies — the other is derived. */
export type HelixCoilMode = 'turns' | 'pitch';

/** The axis slot's state (axis mode) — the shared axis-picker state machine. */
export type HelixAxisSelection = AxisSelection;

/** The face slot's state (face mode): a fresh pick, or the kept statement face. */
export type HelixFaceSelection = { kind: 'picked' } | { kind: 'keep' };

/** The chained geometry options, or the message to show when a field is invalid. */
export type HelixValues =
  | {
      mode: HelixSourceMode;
      radius: ValueExpr | null;
      endRadius: ValueExpr | null;
      pitch: ValueExpr | null;
      turns: ValueExpr | null;
      height: ValueExpr | null;
      startOffset: ValueExpr | null;
      endOffset: ValueExpr | null;
      newVariables?: NewVariable[];
    }
  | { error: string };

/** One optional numeric field's read: omitted (empty), a value, or an error. */
type OptionalRead =
  | { value: ValueExpr | null; newVariable?: NewVariable }
  | { error: string };

/**
 * The helix dialog on the create rails: a From-axis / From-face tab row (the
 * source mode), the matching source pick slot — the axis slot (a single chip,
 * plus X/Y/Z quick buttons, an axis line or a solid edge picked in 3D — the
 * revolve axis idiom) or the face slot (a single cylindrical/conical face
 * picked in 3D — the wrap idiom) — and the shared geometry fields (radius, end
 * radius, pitch, turns, height, start/end offset), each an expression input.
 * A helix is a wire, not a solid, so there is no add/remove/new operation.
 * Every field is optional: an empty one omits its chained method and falls to
 * the helix() API default (in face mode, radius/height default from the face).
 * Pure DOM + form state — the service owns scene data, the picked entities,
 * previews, and the apply call.
 */
export class HelixPanel extends FeaturePanel {
  /** The source mode tab changed — the service re-aims the viewer pick channels. */
  onModeChange?: () => void;
  /** The axis slot left edge mode (✕, a standard/axis pick) — drop the entity. */
  onAxisModeChange?: () => void;
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private modeTabs: ChoiceTabs<HelixSourceMode>;
  private coilTabs: ChoiceTabs<HelixCoilMode>;
  private axisGroup: HTMLElement;
  private faceGroup: HTMLElement;
  private axisSlot: AxisSlotControl;
  private faceSlot: EntitySlotControl;
  private radiusRow: HTMLElement;
  private turnsRow: HTMLElement;
  private pitchRow: HTMLElement;
  private radiusField: ExpressionField;
  private endRadiusField: ExpressionField;
  private pitchField: ExpressionField;
  private turnsField: ExpressionField;
  private heightField: ExpressionField;
  private startOffsetField: ExpressionField;
  private endOffsetField: ExpressionField;

  private mode: HelixSourceMode = 'axis';
  /** Edit mode: the source slot starts on a "Current: …" chip. */
  private editMode = false;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-helix-panel',
      title: 'Helix',
      icon: '/icons/helix.png',
      bodyHtml: `
        <div data-role="mode-tabs" class="join w-full"></div>
        <div data-role="axis-group" class="flex flex-col gap-1.5">
          <div data-role="axis-slot"></div>
          <div data-role="axis-buttons" class="join w-full"></div>
        </div>
        <div data-role="face-group" class="flex flex-col gap-1.5">
          <div data-role="face-slot"></div>
        </div>
        <div data-role="radius-row" class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1.5" title="Start radius — blank uses the API default (20)">
            <span class="text-base-content/70">Radius</span>
            <input data-role="radius" type="number" step="1" class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5"
            title="End radius — set it different from radius for a tapered (conical) helix">
            <span class="text-base-content/70">End radius</span>
            <input data-role="end-radius" type="number" step="1" placeholder="taper"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Coil by</span>
          <div data-role="coil-tabs" class="join w-full"></div>
          <label data-role="turns-row" class="flex flex-col gap-1"
            title="Number of full turns (fractional allowed)">
            <input data-role="turns" type="number" step="0.5"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label data-role="pitch-row" class="flex flex-col gap-1" title="Axial rise per full turn">
            <input data-role="pitch" type="number" step="1"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <label class="flex flex-col gap-1.5"
          title="Total axial height — leave blank to size it from the coil (turns × pitch) or the face">
          <span class="text-base-content/70">Height</span>
          <input data-role="height" type="number" step="1" placeholder="auto"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1.5"
            title="Shift the start along the axis — negative extends past the source">
            <span class="text-base-content/70">Start offset</span>
            <input data-role="start-offset" type="number" step="1" placeholder="0"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5"
            title="Shift the end along the axis — positive extends past the source">
            <span class="text-base-content/70">End offset</span>
            <input data-role="end-offset" type="number" step="1" placeholder="0"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
      `,
    });

    this.modeTabs = new ChoiceTabs<HelixSourceMode>(
      this.role('mode-tabs'),
      [
        { key: 'axis', label: 'From axis', title: 'Build the helix around an axis — helix(<axis>)' },
        { key: 'face', label: 'From face', title: 'Build the helix on a cylindrical/conical face — helix(<face>)' },
      ],
      'axis',
    );
    this.modeTabs.onChange = () => this.handleModeChange();

    this.coilTabs = new ChoiceTabs<HelixCoilMode>(
      this.role('coil-tabs'),
      [
        { key: 'turns', label: 'Turns', title: 'Specify the number of full turns' },
        { key: 'pitch', label: 'Pitch', title: 'Specify the axial rise per turn' },
      ],
      'turns',
    );
    this.coilTabs.onChange = () => this.handleCoilModeChange();

    this.axisGroup = this.role('axis-group');
    this.faceGroup = this.role('face-group');
    this.radiusRow = this.role('radius-row');
    this.turnsRow = this.role('turns-row');
    this.pitchRow = this.role('pitch-row');

    this.axisSlot = new AxisSlotControl(this.role('axis-slot'), this.role('axis-buttons'), {
      buttonTitle: (axis) => `Build the helix around the world ${axis} axis`,
    });
    // A single-slot dialog: the armed border always sits on the active mode's
    // slot, so pin it on (the mode tab, not a slot click, switches targets).
    this.axisSlot.setArmed(true);
    this.axisSlot.onChange = () => this.onChange?.();
    this.axisSlot.onModeChange = () => this.onAxisModeChange?.();

    this.faceSlot = new EntitySlotControl(this.role('face-slot'), {
      label: 'Cylindrical face',
      prompt: 'Pick a cylindrical face',
    });
    this.faceSlot.setArmed(true);
    this.faceSlot.onRemove = () => this.onRemoveFace?.();

    this.radiusField = this.enhance('radius');
    this.endRadiusField = this.enhance('end-radius');
    this.pitchField = this.enhance('pitch');
    this.turnsField = this.enhance('turns');
    this.heightField = this.enhance('height');
    this.startOffsetField = this.enhance('start-offset');
    this.endOffsetField = this.enhance('end-offset');
  }

  /** The active source mode (which slot picks are routed to). */
  get sourceMode(): HelixSourceMode {
    return this.mode;
  }

  /** The variables every field's dropdown offers. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.allFields()) {
      field.setVariables(variables);
    }
  }

  show(axes: AxisOption[]): void {
    // A fresh arming starts from that mode's defaults — the previous session's
    // choices would otherwise be revived by source-line matching.
    this.editMode = false;
    this.mode = 'axis';
    this.shell.setTitle(null);
    this.modeTabs.setValue('axis');
    this.applyModeDefaults('axis');
    this.axisSlot.reset();
    this.axisSlot.setOptions(axes);
    this.faceSlot.reset();
    this.syncModeVisibility();
    this.syncCoilVisibility();
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The source slot for
   * the parsed mode starts on a "Current: …" chip that keeps the statement's
   * own expression verbatim; picking another axis/edge (or a face) re-sources
   * it, and its ✕ reverts to the kept expression. The geometry fields edit in
   * place. Switching tabs asks for a fresh pick in the other mode.
   */
  showEdit(state: {
    mode: HelixSourceMode;
    sourceLabel: string;
    radius: ValueExpr | null;
    endRadius: ValueExpr | null;
    pitch: ValueExpr | null;
    turns: ValueExpr | null;
    height: ValueExpr | null;
    startOffset: ValueExpr | null;
    endOffset: ValueExpr | null;
  }): void {
    this.editMode = true;
    this.mode = state.mode;
    this.shell.setTitle('Edit helix');
    this.modeTabs.setValue(state.mode);
    // The parsed mode's slot seeds with the statement's own source; the other
    // mode's slot stays empty — switching tabs asks for a fresh pick. The
    // face keep rides the same label so a face-tab visit shows it verbatim.
    if (state.mode === 'axis') {
      this.axisSlot.seedKeep(state.sourceLabel);
    } else {
      this.axisSlot.reset();
    }
    this.faceSlot.seedKeep(state.sourceLabel);
    // A helix specifies EITHER turns or pitch — open on whichever the statement
    // carries (turns wins if hand-written code somehow set both).
    this.coilTabs.setValue(state.turns !== null ? 'turns' : state.pitch !== null ? 'pitch' : 'turns');
    this.setFieldValue(this.radiusField, state.radius);
    this.setFieldValue(this.endRadiusField, state.endRadius);
    this.setFieldValue(this.pitchField, state.pitch);
    this.setFieldValue(this.turnsField, state.turns);
    this.setFieldValue(this.heightField, state.height);
    this.setFieldValue(this.startOffsetField, state.startOffset);
    this.setFieldValue(this.endOffsetField, state.endOffset);
    this.syncModeVisibility();
    this.syncCoilVisibility();
    this.shell.show();
  }

  /**
   * Refresh the offered axes after a re-render, keeping the current choice
   * when the same statement is still offered (matched by source location —
   * scene ids change every render). A choice that vanished falls back to the
   * "Current: …" chip in edit mode, or to the pick prompt. Standard-axis and
   * picked-edge states are scene-independent and survive as they are.
   */
  setAxisOptions(axes: AxisOption[]): void {
    this.axisSlot.setOptions(axes);
  }

  axisSelection(): HelixAxisSelection | null {
    return this.mode === 'axis' ? this.axisSlot.selection : null;
  }

  faceSelection(): HelixFaceSelection | null {
    return this.mode === 'face' ? this.faceSlot.selection() : null;
  }

  /**
   * An axis picked in 3D or the timeline (axis mode). No change event fires —
   * the service schedules the preview itself.
   */
  selectAxis(option: AxisOption): void {
    this.axisSlot.selectOption(option);
  }

  /**
   * The axis slot's picked-edge chip (the service owns the entity); null
   * clears it — back to the statement's own axis (edit mode), else the prompt.
   */
  setAxisEdgeChip(label: string | null): void {
    this.axisSlot.setEdgeChip(label);
  }

  /**
   * The face slot's picked chip (the service owns the entity); null clears it
   * — back to the statement's own face (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.faceSlot.setChip(label);
  }

  values(): HelixValues {
    // A face fixes both radii by its geometry — the radius row is axis-only.
    const radius = this.mode === 'axis'
      ? this.readOptional(this.radiusField, { positive: true, label: 'radius' })
      : { value: null } as OptionalRead;
    const endRadius = this.mode === 'axis'
      ? this.readOptional(this.endRadiusField, { positive: true, label: 'end radius' })
      : { value: null } as OptionalRead;
    // A helix is driven by EITHER turns or pitch — read only the active one so
    // the hidden field's stale value never rides into the statement.
    const coilTurns = this.coilTabs.value === 'turns';
    const pitch = coilTurns
      ? { value: null } as OptionalRead
      : this.readOptional(this.pitchField, { nonZero: true, label: 'pitch' });
    const turns = coilTurns
      ? this.readOptional(this.turnsField, { positive: true, label: 'turns' })
      : { value: null } as OptionalRead;
    const height = this.readOptional(this.heightField, { positive: true, label: 'height' });
    const startOffset = this.readOptional(this.startOffsetField, { label: 'start offset' });
    const endOffset = this.readOptional(this.endOffsetField, { label: 'end offset' });

    const reads = [radius, endRadius, pitch, turns, height, startOffset, endOffset];
    for (const read of reads) {
      if ('error' in read) {
        return { error: read.error };
      }
    }
    // The guard above rules out every error read; the rest carry a value.
    const ok = reads as { value: ValueExpr | null; newVariable?: NewVariable }[];
    return {
      mode: this.mode,
      radius: ok[0].value,
      endRadius: ok[1].value,
      pitch: ok[2].value,
      turns: ok[3].value,
      height: ok[4].value,
      startOffset: ok[5].value,
      endOffset: ok[6].value,
      newVariables: collectNewVariables(ok),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleModeChange(): void {
    this.mode = this.modeTabs.value;
    this.syncModeVisibility();
    // Create mode resets to the new mode's canonical defaults; edit mode keeps
    // the parsed values (only the source slot swaps).
    if (!this.editMode) {
      this.applyModeDefaults(this.mode);
      this.syncCoilVisibility();
    }
    this.onModeChange?.();
    this.onChange?.();
  }

  private handleCoilModeChange(): void {
    this.syncCoilVisibility();
    this.onChange?.();
  }

  /**
   * Seed a mode's fields with a helix that renders well straight away: an axis
   * coil sets radius + turns (with a pitch ready behind the Pitch tab); a face
   * helix leaves radius/height blank so they derive from the face, needing only
   * a turn count (matching helix(select(face().cylinder())).turns(n)). Both
   * default to specifying by turns.
   */
  private applyModeDefaults(mode: HelixSourceMode): void {
    this.coilTabs.setValue('turns');
    if (mode === 'axis') {
      this.radiusField.setValue(15);
      this.endRadiusField.setValue('');
      this.pitchField.setValue(10);
      this.turnsField.setValue(4);
      this.heightField.setValue('');
      this.startOffsetField.setValue('');
      this.endOffsetField.setValue('');
    } else {
      this.radiusField.setValue('');
      this.endRadiusField.setValue('');
      this.pitchField.setValue(10);
      this.turnsField.setValue(6);
      this.heightField.setValue('');
      this.startOffsetField.setValue('');
      this.endOffsetField.setValue('');
    }
  }

  private syncModeVisibility(): void {
    this.axisGroup.classList.toggle('hidden', this.mode !== 'axis');
    this.faceGroup.classList.toggle('hidden', this.mode !== 'face');
    // A face fixes the radius (and end radius) by its own geometry, so the
    // whole radius row is axis-only — end radius tapers a conical axis helix.
    this.radiusRow.classList.toggle('hidden', this.mode !== 'axis');
  }

  /** Show only the active coil field — turns or pitch, never both. */
  private syncCoilVisibility(): void {
    const turns = this.coilTabs.value === 'turns';
    this.turnsRow.classList.toggle('hidden', !turns);
    this.pitchRow.classList.toggle('hidden', turns);
  }

  private setFieldValue(field: ExpressionField, value: ValueExpr | null): void {
    field.setValue(value === null ? '' : value);
  }

  /**
   * Read an optional field: empty omits it (null), a plain number runs its
   * range check, an expression commits verbatim (its declaration rides along).
   */
  private readOptional(
    field: ExpressionField,
    opts: { positive?: boolean; nonZero?: boolean; label: string },
  ): OptionalRead {
    const read = field.read();
    if ('error' in read) {
      if (read.error === 'empty') {
        return { value: null };
      }
      return { error: `Enter a valid ${opts.label} — ${read.error}.` };
    }
    if (typeof read.value === 'number') {
      if (opts.positive && read.value <= 0) {
        return { error: `The ${opts.label} must be greater than 0.` };
      }
      if (opts.nonZero && read.value === 0) {
        return { error: `The ${opts.label} must be non-zero.` };
      }
    }
    return { value: read.value, newVariable: read.newVariable };
  }

  private allFields(): ExpressionField[] {
    return [
      this.radiusField, this.endRadiusField, this.pitchField, this.turnsField,
      this.heightField, this.startOffsetField, this.endOffsetField,
    ];
  }
}
