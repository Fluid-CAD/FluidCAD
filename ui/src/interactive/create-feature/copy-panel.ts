import { FeaturePanel } from './feature-panel';
import { AxisOption } from './axis-options';
import { AxisSelection, AxisSlotControl } from './axis-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

export type CopyType = 'linear' | 'circular';

/** The linear directions the panel offers — Direction 1 and an optional 2. */
export type CopyDirection = 1 | 2;

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type CopyArmedSlot = 'targets' | 'axis1' | 'axis2';

/**
 * An axis slot's state — the shared axis-picker state machine, with the kept
 * statement axis carrying its position in the parsed `axisTexts`.
 */
export type CopyAxisSelection =
  | Exclude<AxisSelection, { kind: 'keep' }>
  | { kind: 'keep'; sourceIndex: number };

/** Validated form values, or the message to show when a field is invalid. */
export type CopyValues =
  | {
      kind: 'linear';
      spacingMode: 'offset' | 'length';
      centered: boolean;
      /** Count/value per active direction; the axes ride the service. */
      directions: { count: ValueExpr; value: ValueExpr }[];
      newVariables?: NewVariable[];
    }
  | {
      kind: 'circular';
      count: ValueExpr;
      sweep: { mode: 'angle' | 'offset'; value: ValueExpr };
      newVariables?: NewVariable[];
    }
  | { error: string };

/**
 * The copy dialog: a Linear / Circular type dropdown (the copy kind), the
 * solids slot — filled from whole-solid viewport picks (any face or edge
 * click selects the owning solid) or timeline rows, one numbered chip per
 * solid being copied — plus the kind's inputs. Linear shows a Direction 1
 * group (axis slot + X/Y/Z quick buttons, Total Count, the shared
 * Offset/Total spacing mode with its value) and an "Add second direction"
 * button revealing a Direction 2 group with its own axis, count and value
 * (its ✕ removes it); more axes stay a hand-written-code affair. Circular
 * reuses the Direction 1 axis slot alone with a count and a Total/Offset
 * angle. Exactly one slot is ARMED at a time — clicked to activate, marked
 * by the primary border (the sweep/loft idiom) — and the viewer's pick
 * channels follow it: the armed Solids slot takes whole-shape picks, an
 * armed axis slot takes axis lines and solid edges. Pure DOM + form state —
 * the service owns scene data, the picked entities, previews, and the apply
 * call.
 */
export class CopyPanel extends FeaturePanel {
  /** The type dropdown changed — the service re-aims the viewer pick channels. */
  onTypeChange?: () => void;
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** An axis slot left edge mode (✕, a standard/axis pick) — drop its entity. */
  onAxisModeChange?: (direction: CopyDirection) => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: CopyArmedSlot = 'targets';

  private kindSelect: HTMLSelectElement;
  private targetsSlot: PickSlot;
  private dir1Header: HTMLElement;
  private axisSlots = new Map<CopyDirection, AxisSlotControl>();
  private spacingRow: HTMLElement;
  private spacingModeSelect: HTMLSelectElement;
  private sweepRow: HTMLElement;
  private sweepModeSelect: HTMLSelectElement;
  private dir2Wrap: HTMLElement;
  private value2Label: HTMLElement;
  private addDirectionBtn: HTMLButtonElement;
  private centeredRow: HTMLElement;
  private centeredInput: HTMLInputElement;
  private countField: ExpressionField;
  private spacingField: ExpressionField;
  private sweepField: ExpressionField;
  private count2Field: ExpressionField;
  private value2Field: ExpressionField;

  /** The Direction 2 group is active (linear only). */
  private dir2 = false;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-copy-panel',
      title: 'Copy',
      icon: '/icons/copy-linear.png',
      bodyHtml: `
        <label class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Type</span>
          <select data-role="kind" class="select select-sm select-bordered w-full text-xs">
            <option value="linear" title="Copy along one or two axes — copy('linear', …)">Linear</option>
            <option value="circular" title="Copy around an axis — copy('circular', …)">Circular</option>
          </select>
        </label>
        <div data-role="targets-slot"></div>
        <div data-role="axis-wrap" class="flex flex-col gap-1.5">
          <span data-role="dir1-header" class="text-base-content/70 font-medium">Direction 1</span>
          <div data-role="axis-slot-1"></div>
          <div data-role="axis-buttons-1" class="join w-full"></div>
        </div>
        <label data-role="count-row" class="flex flex-col gap-1.5" title="Number of instances, the original included">
          <span class="text-base-content/70">Total Count</span>
          <input data-role="count" type="number" step="1" min="2" value="3"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div data-role="spacing-row" class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Spacing</span>
          <div class="flex items-center gap-1.5">
            <select data-role="spacing-mode" class="select select-sm select-bordered w-1/2 min-w-0 text-xs"
              title="Offset: distance between neighbors. Total: the whole span, distributed evenly — length. Shared by both directions.">
              <option value="offset">Offset</option>
              <option value="length">Total</option>
            </select>
            <input data-role="spacing" type="number" step="1" value="20"
              class="input input-sm input-bordered w-full min-w-0 text-xs" />
          </div>
        </div>
        <div data-role="sweep-row" class="hidden flex-col gap-1.5">
          <span class="text-base-content/70">Angle (°)</span>
          <div class="flex items-center gap-1.5">
            <select data-role="sweep-mode" class="select select-sm select-bordered w-1/2 min-w-0 text-xs"
              title="Total: the whole sweep, distributed evenly — angle. Offset: degrees between neighbors.">
              <option value="angle">Total</option>
              <option value="offset">Offset</option>
            </select>
            <input data-role="sweep" type="number" step="5" value="360"
              class="input input-sm input-bordered w-full min-w-0 text-xs" />
          </div>
        </div>
        <div data-role="dir2-wrap" class="hidden flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-base-content/70 font-medium">Direction 2</span>
            <button data-role="dir2-remove" class="btn btn-ghost btn-xs px-1.5"
              title="Remove the second direction">✕</button>
          </div>
          <div data-role="axis-slot-2"></div>
          <div data-role="axis-buttons-2" class="join w-full"></div>
          <label class="flex flex-col gap-1.5" title="Number of instances along the second direction, the original included">
            <span class="text-base-content/70">Total Count</span>
            <input data-role="count2" type="number" step="1" min="2" value="2"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5" title="Spacing along the second direction — the Offset/Total mode is shared with Direction 1">
            <span data-role="value2-label" class="text-base-content/70">Offset</span>
            <input data-role="value2" type="number" step="1" value="20"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
        </div>
        <button data-role="add-direction" class="btn btn-ghost btn-sm justify-start px-1 font-normal text-primary"
          title="Copy along a second axis too — copy('linear', [a1, a2], …)">+ Add second direction</button>
        <label data-role="centered-row" class="flex items-center justify-between cursor-pointer"
          title="Center the copies on the original instance">
          <span class="text-base-content/70">Centered</span>
          <input data-role="centered" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
      `,
    });

    this.kindSelect = this.role('kind');
    this.kindSelect.addEventListener('change', () => {
      this.syncType();
      this.onTypeChange?.();
      this.onChange?.();
    });

    this.targetsSlot = new PickSlot(this.role('targets-slot'), { label: 'Solids', multiple: true });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.dir1Header = this.role('dir1-header');
    for (const direction of [1, 2] as const) {
      const control = new AxisSlotControl(
        this.role(`axis-slot-${direction}`),
        this.role(`axis-buttons-${direction}`),
        { buttonTitle: (axis) => `Copy along the world ${axis} axis` },
      );
      control.onArm = () => this.armSlot(direction === 2 ? 'axis2' : 'axis1');
      control.onModeChange = () => this.onAxisModeChange?.(direction);
      control.onChange = () => this.onChange?.();
      this.axisSlots.set(direction, control);
    }

    this.spacingRow = this.role('spacing-row');
    this.spacingModeSelect = this.role('spacing-mode');
    this.sweepRow = this.role('sweep-row');
    this.sweepModeSelect = this.role('sweep-mode');
    this.dir2Wrap = this.role('dir2-wrap');
    this.value2Label = this.role('value2-label');
    this.addDirectionBtn = this.role('add-direction');
    this.centeredRow = this.role('centered-row');
    this.centeredInput = this.role('centered');

    this.addDirectionBtn.addEventListener('click', () => {
      this.dir2 = true;
      // A re-added direction restores its kept statement axis (edit mode).
      if (!this.axisSlots.get(2)!.selection) {
        this.axisSlots.get(2)!.restoreFallback();
      }
      // The fresh direction is the one being composed — its slot takes the
      // next axis pick.
      this.armSlot('axis2');
      this.syncType();
      this.onChange?.();
    });
    this.role('dir2-remove').addEventListener('click', () => {
      this.dir2 = false;
      this.axisSlots.get(2)!.clear();
      if (this.armedSlot === 'axis2') {
        this.armSlot('axis1');
      }
      this.syncType();
      this.onAxisModeChange?.(2);
      this.onChange?.();
    });

    this.spacingModeSelect.addEventListener('change', () => {
      this.syncSpacingLabels();
      this.onChange?.();
    });
    this.sweepModeSelect.addEventListener('change', () => this.onChange?.());
    this.centeredInput.addEventListener('change', () => this.onChange?.());
    this.countField = this.enhance('count');
    this.spacingField = this.enhance('spacing');
    this.sweepField = this.enhance('sweep');
    this.count2Field = this.enhance('count2');
    this.value2Field = this.enhance('value2');
  }

  private expressionFields(): ExpressionField[] {
    return [
      this.countField, this.spacingField, this.sweepField,
      this.count2Field, this.value2Field,
    ];
  }

  /** The variables the fields' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.expressionFields()) {
      field.setVariables(variables);
    }
  }

  get copyType(): CopyType {
    return this.kindSelect.value === 'circular' ? 'circular' : 'linear';
  }

  /** The active linear directions: [1] or [1, 2]. */
  get directions(): CopyDirection[] {
    return this.copyType === 'linear' && this.dir2 ? [1, 2] : [1];
  }

  /** The direction whose axis slot takes the next 3D axis/edge pick. */
  get armedAxis(): CopyDirection {
    return this.armedSlot === 'axis2' ? 2 : 1;
  }

  show(): void {
    // A fresh arming starts from defaults and empty slots — the previous
    // session's choices would otherwise be revived by source-line matching.
    this.shell.setTitle(null);
    this.kindSelect.value = 'linear';
    this.axisSlots.get(1)!.reset();
    this.axisSlots.get(2)!.reset();
    this.dir2 = false;
    this.countField.setValue(3);
    this.spacingModeSelect.value = 'offset';
    this.spacingField.setValue(20);
    this.sweepModeSelect.value = 'angle';
    this.sweepField.setValue(360);
    this.count2Field.setValue(2);
    this.value2Field.setValue(20);
    this.centeredInput.checked = false;
    this.setTargets([]);
    // The empty solids list is the first thing to fill — its slot opens
    // armed, taking whole-shape picks right away.
    this.armSlot('targets');
    this.syncSpacingLabels();
    this.syncType();
    this.shell.show();
  }

  /** Programmatic type choice (selection seeding); no change event fires. */
  setType(type: CopyType): void {
    this.kindSelect.value = type;
    this.syncType();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The axis slots
   * start on "Current: …" chips that keep the statement's own expressions
   * verbatim (per direction, by position); re-sourcing is live and a
   * re-picked chip's ✕ reverts to the kept expression. Fields the statement
   * doesn't carry (a kind switch reveals them) seed with the create
   * defaults. The targets slot is seeded by the service.
   */
  showEdit(state: {
    kind: CopyType;
    directions: { count: ValueExpr; value: ValueExpr }[] | null;
    spacingMode: 'offset' | 'length' | null;
    centered: boolean;
    count: ValueExpr | null;
    sweep: { mode: 'angle' | 'offset'; value: ValueExpr } | null;
    /** Keep-chip labels, one per statement axis (`axisTexts`). */
    axisLabels: string[];
  }): void {
    this.shell.setTitle('Edit copy');
    this.kindSelect.value = state.kind;
    this.dir2 = (state.directions?.length ?? 0) === 2;
    this.countField.setValue(
      state.kind === 'linear' ? state.directions?.[0]?.count ?? 3 : state.count ?? 3,
    );
    this.spacingModeSelect.value = state.spacingMode ?? 'offset';
    this.spacingField.setValue(state.directions?.[0]?.value ?? 20);
    this.sweepModeSelect.value = state.sweep?.mode ?? 'angle';
    this.sweepField.setValue(state.sweep?.value ?? 360);
    this.count2Field.setValue(state.directions?.[1]?.count ?? 2);
    this.value2Field.setValue(state.directions?.[1]?.value ?? 20);
    this.centeredInput.checked = state.centered;
    this.axisSlots.get(1)!.seedKeep(state.axisLabels[0] ?? null);
    this.axisSlots.get(2)!.seedKeep(state.axisLabels[1] ?? null);
    this.setTargets([]);
    // The targets list is the seeded statement's — its slot opens armed like
    // create mode, ready to toggle solids in the viewport.
    this.armSlot('targets');
    this.syncSpacingLabels();
    this.syncType();
    this.shell.show();
  }

  /**
   * Refresh the offered axis statements after a re-render, keeping the
   * current choices when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that
   * vanished falls back to the pick prompt. Standard and picked-entity
   * states are scene-independent and survive as they are (the service
   * re-validates entity picks itself).
   */
  setOptions(axes: AxisOption[]): void {
    for (const direction of [1, 2] as const) {
      this.axisSlots.get(direction)!.setOptions(axes);
    }
  }

  /** Render the target chips — numbered, the copy's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick solids in the viewport');
  }

  axisSelection(direction: CopyDirection = 1): CopyAxisSelection | null {
    const selection = this.axisSlots.get(direction)!.selection;
    if (selection?.kind === 'keep') {
      // The kept statement axis sits at its direction's position in the
      // parsed `axisTexts` — the service rewrites it verbatim by index.
      return { kind: 'keep', sourceIndex: direction - 1 };
    }
    return selection;
  }

  /**
   * An axis picked in 3D or the timeline — it lands in the armed direction's
   * slot, arming it so the border tracks where the pick landed. No change
   * event fires.
   */
  selectAxis(option: AxisOption): void {
    const direction = this.armedAxis;
    this.axisSlots.get(direction)!.selectOption(option);
    this.armSlot(direction === 2 ? 'axis2' : 'axis1');
  }

  /**
   * A direction's picked-edge chip (the service owns the entity); null
   * clears it back to the prompt.
   */
  setAxisEdgeChip(direction: CopyDirection, label: string | null): void {
    this.axisSlots.get(direction)!.setEdgeChip(label);
  }

  values(): CopyValues {
    const kind = this.copyType;
    if (kind === 'linear') {
      const spacingMode = this.spacingModeSelect.value === 'length' ? 'length' : 'offset';
      const directions: { count: ValueExpr; value: ValueExpr }[] = [];
      const reads: { newVariable?: NewVariable }[] = [];
      for (const direction of this.directions) {
        const countField = direction === 1 ? this.countField : this.count2Field;
        const valueField = direction === 1 ? this.spacingField : this.value2Field;
        const which = this.dir2 ? ` for direction ${direction}` : '';
        const count = countField.read();
        if ('error' in count
          || (typeof count.value === 'number' && (!Number.isInteger(count.value) || count.value < 2))) {
          return { error: `Enter a whole count of at least 2${which} (the original included).` };
        }
        const value = valueField.read();
        if ('error' in value || (typeof value.value === 'number' && value.value === 0)) {
          return { error: `Enter a nonzero spacing distance${which}.` };
        }
        reads.push(count, value);
        directions.push({ count: count.value, value: value.value });
      }
      return {
        kind, spacingMode, centered: this.centeredInput.checked, directions,
        newVariables: collectNewVariables(reads),
      };
    }
    const count = this.countField.read();
    if ('error' in count
      || (typeof count.value === 'number' && (!Number.isInteger(count.value) || count.value < 2))) {
      return { error: 'Enter a whole count of at least 2 (the original included).' };
    }
    const value = this.sweepField.read();
    if ('error' in value || (typeof value.value === 'number' && value.value === 0)) {
      return { error: 'Enter a nonzero sweep angle in degrees.' };
    }
    const mode = this.sweepModeSelect.value === 'offset' ? 'offset' : 'angle';
    return {
      kind, count: count.value, sweep: { mode, value: value.value },
      newVariables: collectNewVariables([count, value]),
    };
  }

  /**
   * Arm one slot: it wears the primary border and the viewer's pick
   * channels follow it — the armed Solids slot takes whole-shape picks, an
   * armed axis slot takes axis lines and solid edges. The service re-aims
   * the channels on every actual change.
   */
  armSlot(slot: CopyArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.axisSlots.get(1)!.setArmed(slot === 'axis1');
    this.axisSlots.get(2)!.setArmed(slot === 'axis2');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }

  /** The Direction 2 value label mirrors the shared Offset/Total mode. */
  private syncSpacingLabels(): void {
    this.value2Label.textContent = this.spacingModeSelect.value === 'length' ? 'Total' : 'Offset';
  }

  /** Show the rows the current kind takes; hide the rest. */
  private syncType(): void {
    const kind = this.copyType;
    const linear = kind === 'linear';
    // The Direction 1 header only earns its row when a second direction can
    // exist; circular shows the bare axis slot.
    this.dir1Header.classList.toggle('hidden', !linear);
    this.spacingRow.classList.toggle('hidden', !linear);
    this.spacingRow.classList.toggle('flex', linear);
    this.sweepRow.classList.toggle('hidden', linear);
    this.sweepRow.classList.toggle('flex', !linear);
    this.dir2Wrap.classList.toggle('hidden', !(linear && this.dir2));
    this.dir2Wrap.classList.toggle('flex', linear && this.dir2);
    this.addDirectionBtn.classList.toggle('hidden', !(linear && !this.dir2));
    this.centeredRow.classList.toggle('hidden', !linear);
    this.centeredRow.classList.toggle('flex', linear);
    // An armed Direction 2 slot the circular kind hides falls to Direction 1.
    if (!linear && this.armedSlot === 'axis2') {
      this.armSlot('axis1');
    }
  }
}
