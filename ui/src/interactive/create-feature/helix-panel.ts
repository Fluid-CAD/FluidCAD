import { ChoiceTabs, PanelShell } from './panel-controls';
import { AxisOption } from './axis-options';
import { sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Which geometry the helix is built around — the two dialog tabs. */
export type HelixSourceMode = 'axis' | 'face';

/** Which coil dimension the dialog specifies — the other is derived. */
export type HelixCoilMode = 'turns' | 'pitch';

/**
 * The axis slot's state (axis mode): a standard world axis (the X/Y/Z quick
 * buttons), an existing axis statement, a picked edge (the service owns the
 * entity), or — edit mode only — the statement's own axis expression kept
 * verbatim. Mirrors the revolve dialog's axis slot.
 */
export type HelixAxisSelection =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'keep' };

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

const STANDARD_AXES = ['x', 'y', 'z'] as const;

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
export class HelixPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The source mode tab changed — the service re-aims the viewer pick channels. */
  onModeChange?: () => void;
  /** The axis slot left edge mode (✕, a standard/axis pick) — drop the entity. */
  onAxisModeChange?: () => void;
  /** The face chip's ✕ — the service owns the picked entity. */
  onRemoveFace?: () => void;

  private shell: PanelShell;
  private modeTabs: ChoiceTabs<HelixSourceMode>;
  private coilTabs: ChoiceTabs<HelixCoilMode>;
  private axisGroup: HTMLElement;
  private faceGroup: HTMLElement;
  private axisSlot: PickSlot;
  private faceSlot: PickSlot;
  private axisButtons = new Map<'x' | 'y' | 'z', HTMLButtonElement>();
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
  private applyBtn: HTMLButtonElement;

  private mode: HelixSourceMode = 'axis';
  private axisState: HelixAxisSelection | null = null;
  /** Picked-face chip label (the service owns the entity), or null. */
  private pickedFaceLabel: string | null = null;
  /** Edit mode: the source slot starts on a "Current: …" chip. */
  private editMode = false;
  /** The edited statement's own source expression, verbatim. */
  private keepSourceLabel = '';

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-helix-panel', 'Helix', '/icons/helix.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
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
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.modeTabs = new ChoiceTabs<HelixSourceMode>(
      this.shell.body.querySelector('[data-role="mode-tabs"]')!,
      [
        { key: 'axis', label: 'From axis', title: 'Build the helix around an axis — helix(<axis>)' },
        { key: 'face', label: 'From face', title: 'Build the helix on a cylindrical/conical face — helix(<face>)' },
      ],
      'axis',
    );
    this.modeTabs.onChange = () => this.handleModeChange();

    this.coilTabs = new ChoiceTabs<HelixCoilMode>(
      this.shell.body.querySelector('[data-role="coil-tabs"]')!,
      [
        { key: 'turns', label: 'Turns', title: 'Specify the number of full turns' },
        { key: 'pitch', label: 'Pitch', title: 'Specify the axial rise per turn' },
      ],
      'turns',
    );
    this.coilTabs.onChange = () => this.handleCoilModeChange();

    this.axisGroup = this.shell.body.querySelector('[data-role="axis-group"]')!;
    this.faceGroup = this.shell.body.querySelector('[data-role="face-group"]')!;
    this.radiusRow = this.shell.body.querySelector('[data-role="radius-row"]')!;
    this.turnsRow = this.shell.body.querySelector('[data-role="turns-row"]')!;
    this.pitchRow = this.shell.body.querySelector('[data-role="pitch-row"]')!;

    this.axisSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="axis-slot"]')!,
      { label: 'Axis', multiple: false },
    );
    // A single-slot dialog: the armed border always sits on the active mode's
    // slot, so pin it on (the mode tab, not a slot click, switches targets).
    this.axisSlot.setArmed(true);
    this.axisSlot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own axis (a re-pick is undone, never the axis itself).
      this.axisState = this.editMode ? { kind: 'keep' } : null;
      this.renderAxis();
      this.onAxisModeChange?.();
      this.onChange?.();
    };

    this.faceSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="face-slot"]')!,
      { label: 'Cylindrical face', multiple: false },
    );
    this.faceSlot.setArmed(true);
    this.faceSlot.onRemove = () => this.onRemoveFace?.();

    // The world-axis quick row: one click sets the axis slot without a 3D pick.
    const buttonsHost = this.shell.body.querySelector('[data-role="axis-buttons"]')!;
    for (const axis of STANDARD_AXES) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm join-item flex-1 font-normal';
      btn.textContent = axis.toUpperCase();
      btn.title = `Build the helix around the world ${axis.toUpperCase()} axis`;
      btn.addEventListener('click', () => {
        this.axisState = { kind: 'standard', axis };
        this.renderAxis();
        this.onAxisModeChange?.();
        this.onChange?.();
      });
      buttonsHost.appendChild(btn);
      this.axisButtons.set(axis, btn);
    }

    this.radiusField = this.enhance('radius');
    this.endRadiusField = this.enhance('end-radius');
    this.pitchField = this.enhance('pitch');
    this.turnsField = this.enhance('turns');
    this.heightField = this.enhance('height');
    this.startOffsetField = this.enhance('start-offset');
    this.endOffsetField = this.enhance('end-offset');

    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;
    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
  }

  /** Wrap a dialog input in an ExpressionField wired to the panel's change/submit. */
  private enhance(role: string): ExpressionField {
    const input = this.shell.body.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
    const field = new ExpressionField(input);
    field.onSubmit = () => this.onApply?.();
    input.addEventListener('input', () => this.onChange?.());
    return field;
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
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
    this.axisState = null;
    this.pickedFaceLabel = null;
    this.keepSourceLabel = '';
    this.shell.setTitle(null);
    this.modeTabs.setValue('axis');
    this.applyModeDefaults('axis');
    this.setAxisOptions(axes);
    this.syncModeVisibility();
    this.syncCoilVisibility();
    this.renderAxis();
    this.renderFace();
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
    this.keepSourceLabel = state.sourceLabel;
    this.axisState = state.mode === 'axis' ? this.keepAxisSelection(state.sourceLabel) : null;
    this.pickedFaceLabel = null;
    this.shell.setTitle('Edit helix');
    this.modeTabs.setValue(state.mode);
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
    this.renderAxis();
    this.renderFace();
    this.shell.show();
  }

  /**
   * The edited statement's own axis, seeded into the slot: a standard
   * world-axis literal (`'z'`) reads as the standard selection itself, so its
   * X/Y/Z button lights up and the chip reads "World Z axis"; anything else
   * (a variable, an axis() call) stays a verbatim "Current: …" keep. Mirrors
   * the repeat dialog.
   */
  private keepAxisSelection(sourceLabel: string): HelixAxisSelection {
    const standard = sourceLabel.trim().match(/^['"]([xyz])['"]$/);
    if (standard) {
      return { kind: 'standard', axis: standard[1] as 'x' | 'y' | 'z' };
    }
    return { kind: 'keep' };
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the offered axes after a re-render, keeping the current choice
   * when the same statement is still offered (matched by source location —
   * scene ids change every render). A choice that vanished falls back to the
   * "Current: …" chip in edit mode, or to the pick prompt. Standard-axis and
   * picked-edge states are scene-independent and survive as they are.
   */
  setAxisOptions(axes: AxisOption[]): void {
    if (this.axisState?.kind === 'axis') {
      const prev = this.axisState.option;
      const match = axes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.axisState = match
        ? { kind: 'axis', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    this.renderAxis();
  }

  axisSelection(): HelixAxisSelection | null {
    return this.mode === 'axis' ? this.axisState : null;
  }

  faceSelection(): HelixFaceSelection | null {
    if (this.mode !== 'face') {
      return null;
    }
    if (this.pickedFaceLabel !== null) {
      return { kind: 'picked' };
    }
    if (this.editMode && this.keepSourceLabel) {
      return { kind: 'keep' };
    }
    return null;
  }

  /**
   * An axis picked in 3D or the timeline (axis mode). No change event fires —
   * the service schedules the preview itself.
   */
  selectAxis(option: AxisOption): void {
    this.axisState = { kind: 'axis', option };
    this.renderAxis();
  }

  /**
   * The axis slot's picked-edge chip (the service owns the entity); null
   * clears it — back to the statement's own axis (edit mode), else the prompt.
   */
  setAxisEdgeChip(label: string | null): void {
    if (label !== null) {
      this.axisState = { kind: 'edge' };
    } else if (this.axisState?.kind === 'edge') {
      this.axisState = this.editMode ? { kind: 'keep' } : null;
    }
    this.renderAxis(label ?? undefined);
  }

  /**
   * The face slot's picked chip (the service owns the entity); null clears it
   * — back to the statement's own face (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.pickedFaceLabel = label;
    this.renderFace();
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

  setPreview(text: string | null): void {
    this.shell.setPreview(text);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
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
    this.renderAxis();
    this.renderFace();
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

  /** The axis slot: one chip (the chosen axis), or the pick prompt. */
  private renderAxis(edgeLabel?: string): void {
    const state = this.axisState;
    if (state?.kind === 'keep') {
      this.axisSlot.setChips([{ label: `Current: ${this.keepSourceLabel}`, badge: '●', removable: false }]);
      this.axisSlot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.axisSlot.setChips([{ label: `World ${state.axis.toUpperCase()} axis`, badge: '●', removable: true }]);
      this.axisSlot.setPrompt(null);
    } else if (state?.kind === 'axis') {
      this.axisSlot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.axisSlot.setPrompt(null);
    } else if (state?.kind === 'edge') {
      this.axisSlot.setChips([{ label: edgeLabel ?? 'Picked edge', badge: '●', removable: true }]);
      this.axisSlot.setPrompt(null);
    } else {
      this.axisSlot.setChips([]);
      this.axisSlot.setPrompt('Pick an axis or edge');
    }
    for (const [axis, btn] of this.axisButtons) {
      const active = state?.kind === 'standard' && state.axis === axis;
      btn.classList.toggle('btn-soft', active);
      btn.classList.toggle('btn-primary', active);
    }
  }

  /** The face slot: the picked chip, the kept statement face, or the prompt. */
  private renderFace(): void {
    if (this.pickedFaceLabel !== null) {
      this.faceSlot.setChips([{ label: this.pickedFaceLabel, badge: '●', removable: true }]);
      this.faceSlot.setPrompt(null);
    } else if (this.editMode && this.mode === 'face' && this.keepSourceLabel) {
      this.faceSlot.setChips([{ label: `Current: ${this.keepSourceLabel}`, badge: '●', removable: false }]);
      this.faceSlot.setPrompt(null);
    } else {
      this.faceSlot.setChips([]);
      this.faceSlot.setPrompt('Pick a cylindrical face');
    }
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
