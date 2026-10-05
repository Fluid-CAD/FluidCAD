import { FeaturePanel } from './feature-panel';
import { AxisOption } from './axis-options';
import { AxisSelection, AxisSlotControl, ConnectorAxisSelection } from './axis-slot';
import { ConnectorOption } from './connector-options';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';
import { formatSkipEntries, parseSkipEntries, skipRangeError, SKIP_HELP_HTML } from './copy-skip';
import { HelpPopover, helpIconHtml } from '../../ui/help-popover';
import { DIRECTION_GROUP_CLASSES } from './panel-controls';
import { iconUrl } from '../../ui/icon-url';

/**
 * The copy kind: along axes, around one, or along a repeat — `copy(holes,
 * bolt)`, connectors laid on a repeat's own instances.
 */
export type CopyType = 'linear' | 'circular' | 'pattern';

/** The linear directions the panel offers — Direction 1 and an optional 2. */
export type CopyDirection = 1 | 2;

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type CopyArmedSlot = 'targets' | 'axis1' | 'axis2' | 'pattern';

/**
 * An axis slot's state — the shared axis-picker state machine, plus a
 * connector standing for its Z axis (a copy's axis can be one), with the
 * kept statement axis carrying its position in the parsed `axisTexts`.
 */
export type CopyAxisSelection =
  | Exclude<AxisSelection, { kind: 'keep' }>
  | ConnectorAxisSelection
  | { kind: 'keep'; sourceIndex: number };

/** Validated form values, or the message to show when a field is invalid. */
export type CopyValues =
  | {
      kind: 'linear';
      spacingMode: 'offset' | 'length';
      centered: boolean;
      /** Count/value per active direction; the axes ride the service. */
      directions: { count: ValueExpr; value: ValueExpr }[];
      /** Instances to leave out, one index per direction; empty skips none. */
      skip: number[][];
      newVariables?: NewVariable[];
    }
  | {
      kind: 'circular';
      count: ValueExpr;
      sweep: { mode: 'angle' | 'offset'; value: ValueExpr };
      /** Instances to leave out, each a single index; empty skips none. */
      skip: number[][];
      newVariables?: NewVariable[];
    }
  /** Along a repeat: nothing to read — the repeat states every instance. */
  | { kind: 'pattern' }
  | { error: string };

/**
 * What a copy dialog says around its slots — the part dialog's defaults, or
 * the assembly dialog's, whose targets and axes are connectors only.
 */
export type CopyPanelOptions = {
  /** The panel element's id — one per dialog on the page. */
  id?: string;
  /** The targets slot's label. */
  targetsLabel?: string;
  /** What the empty targets slot asks for. */
  targetsPrompt?: string;
  /** What an empty axis slot asks for. */
  axisPrompt?: string;
  /**
   * Offer "Along a repeat" — the part dialog does; an assembly has no
   * repeat() to follow, so its dialog leaves the type out.
   */
  followsRepeats?: boolean;
};

/**
 * The copy dialog: a Linear / Circular / Along a repeat type dropdown (the
 * copy kind), the targets slot — filled from whole-solid viewport picks (any
 * face or edge click selects the owning solid), connector gizmos, or timeline
 * rows, one numbered chip per solid or connector being copied — plus the
 * kind's inputs. "Along a repeat" (`copy(holes, bolt)`) copies connectors
 * onto a repeat's own instances: it shows a Pattern slot for the repeat and
 * none of the count, spacing, axis or skip fields, and is offered only while
 * every target is a connector ({@link setPatternAvailable}). Every axis slot
 * takes a connector too, standing for its Z axis. Linear shows a Direction 1
 * group (axis slot, Total Count, the shared
 * Offset/Total spacing mode with its value) and an "Add second direction"
 * button revealing a Direction 2 group with its own axis, count and value
 * (its ✕ removes it); more axes stay a hand-written-code affair. Circular
 * reuses the Direction 1 axis slot alone with a count and a Total/Offset
 * angle. Both kinds end on a Skip field naming the instances to leave out by
 * index ({@link parseSkipEntries}). Exactly one slot is ARMED at a time —
 * clicked to activate, marked by the primary border (the sweep/loft idiom) —
 * and the viewer's pick channels follow it: the armed Solids slot takes
 * whole-shape picks, an armed axis slot takes axis lines and solid edges.
 * Pure DOM + form state — the service owns scene data, the picked entities,
 * previews, and the apply call.
 */
export class CopyPanel extends FeaturePanel {
  /** The type dropdown changed — the service re-aims the viewer pick channels. */
  onTypeChange?: () => void;
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** An axis slot left edge mode (✕, a standard/axis pick) — drop its entity. */
  onAxisModeChange?: (direction: CopyDirection) => void;
  /** The Pattern slot's chip was removed. */
  onRemovePattern?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: CopyArmedSlot = 'targets';

  private kindSelect: HTMLSelectElement;
  private patternOption: HTMLOptionElement;
  private targetsSlot: PickSlot;
  private patternSlot: PickSlot;
  private patternWrap: HTMLElement;
  /** The Direction 1 group — axis, count and spacing — boxed like Direction 2 while the kind is linear. */
  private dir1Wrap: HTMLElement;
  private axisWrap: HTMLElement;
  private countRow: HTMLElement;
  private skipRow: HTMLElement;
  private dir1Header: HTMLElement;
  private axisSlots = new Map<CopyDirection, AxisSlotControl<ConnectorAxisSelection>>();
  private spacingRow: HTMLElement;
  private spacingModeSelect: HTMLSelectElement;
  private sweepRow: HTMLElement;
  private sweepModeSelect: HTMLSelectElement;
  private dir2Wrap: HTMLElement;
  private value2Label: HTMLElement;
  private addDirectionBtn: HTMLButtonElement;
  private centeredRow: HTMLElement;
  private centeredInput: HTMLInputElement;
  private skipInput: HTMLInputElement;
  private skipHelp: HelpPopover;
  private countField: ExpressionField;
  private spacingField: ExpressionField;
  private sweepField: ExpressionField;
  private count2Field: ExpressionField;
  private value2Field: ExpressionField;

  /** The Direction 2 group is active (linear only). */
  private dir2 = false;
  /** What the empty targets slot asks for. */
  private readonly targetsPrompt: string;

  constructor(container: HTMLElement, options: CopyPanelOptions = {}) {
    super(container, {
      id: options.id ?? 'fluidcad-copy-panel',
      title: 'Copy',
      icon: iconUrl('copy-linear'),
      bodyHtml: `
        <label class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Type</span>
          <select data-role="kind" class="select select-sm select-bordered w-full text-xs">
            <option value="linear" title="Copy along one or two axes — copy('linear', …)">Linear</option>
            <option value="circular" title="Copy around an axis — copy('circular', …)">Circular</option>
            <option value="pattern" title="Copy connectors onto a repeat's instances — copy(pattern, …)">Along a repeat</option>
          </select>
        </label>
        <div data-role="targets-slot"></div>
        <div data-role="pattern-slot" class="hidden"></div>
        <div data-role="dir1-wrap" class="flex flex-col gap-3">
          <div data-role="axis-wrap" class="flex flex-col gap-1.5">
            <span data-role="dir1-header" class="text-base-content/70 font-medium">Direction 1</span>
            <div data-role="axis-slot-1"></div>
          </div>
          <label data-role="count-row" class="flex flex-col gap-1.5" title="Number of instances, the original included">
            <span class="text-base-content/70">Total Count</span>
            <input data-role="count" type="number" step="1" min="2" value="3"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <div data-role="spacing-row" class="flex flex-col gap-1.5">
            <span class="text-base-content/70">Spacing</span>
            <div class="flex items-center gap-1.5">
              <select data-role="spacing-mode" class="select select-sm select-bordered w-1/2 shrink-0 text-xs"
                title="Offset: distance between neighbors. Total: the whole span, distributed evenly — length. Shared by both directions.">
                <option value="offset">Offset</option>
                <option value="length">Total</option>
              </select>
              <input data-role="spacing" data-unit="length" type="number" step="1" value="20"
                class="input input-sm input-bordered w-full min-w-0 text-xs" />
            </div>
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
        <div data-role="dir2-wrap" class="hidden flex-col gap-3 border border-base-content/10 rounded-md p-3">
          <div class="flex items-center justify-between">
            <span class="text-base-content/70 font-medium">Direction 2</span>
            <button data-role="dir2-remove" class="btn btn-ghost btn-xs px-1.5"
              title="Remove the second direction">✕</button>
          </div>
          <div data-role="axis-slot-2"></div>
          <label class="flex flex-col gap-1.5" title="Number of instances along the second direction, the original included">
            <span class="text-base-content/70">Total Count</span>
            <input data-role="count2" type="number" step="1" min="2" value="2"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label class="flex flex-col gap-1.5" title="Spacing along the second direction — the Offset/Total mode is shared with Direction 1">
            <span data-role="value2-label" class="text-base-content/70">Offset</span>
            <input data-role="value2" data-unit="length" type="number" step="1" value="20"
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
        <div data-role="skip-row" class="flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <span class="text-base-content/70">Skip</span>
            ${helpIconHtml('skip-help', 'How the Skip field works')}
          </div>
          <input data-role="skip" type="text" placeholder="e.g. 1, 3"
            class="input input-sm input-bordered w-full text-xs" />
        </div>
      `,
    });

    this.kindSelect = this.role('kind');
    this.patternOption = this.kindSelect.querySelector<HTMLOptionElement>('option[value="pattern"]')!;
    if (options.followsRepeats === false) {
      this.patternOption.remove();
    }
    this.kindSelect.addEventListener('change', () => {
      // Along a repeat, the repeat is what's left to pick; away from it, the
      // Pattern slot the type hides hands the border back to the targets.
      if (this.copyType === 'pattern') {
        this.armSlot('pattern');
      } else if (this.armedSlot === 'pattern') {
        this.armSlot('targets');
      }
      this.syncType();
      this.onTypeChange?.();
      this.onChange?.();
    });

    this.targetsPrompt = options.targetsPrompt ?? 'Pick solids or connectors in the viewport';
    this.targetsSlot = new PickSlot(this.role('targets-slot'), {
      label: options.targetsLabel ?? 'Solids & connectors',
      multiple: true,
    });
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.patternWrap = this.role('pattern-slot');
    this.patternSlot = new PickSlot(this.patternWrap, { label: 'Pattern', multiple: false });
    this.patternSlot.onArm = () => this.armSlot('pattern');
    this.patternSlot.onRemove = () => this.onRemovePattern?.();
    this.dir1Wrap = this.role('dir1-wrap');
    this.axisWrap = this.role('axis-wrap');
    this.countRow = this.role('count-row');
    this.skipRow = this.role('skip-row');

    this.dir1Header = this.role('dir1-header');
    for (const direction of [1, 2] as const) {
      const control = new AxisSlotControl<ConnectorAxisSelection>(this.role(`axis-slot-${direction}`), {
        prompt: options.axisPrompt ?? 'Pick a world axis, an axis, an edge or a connector',
      });
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
    this.skipInput = this.role('skip');
    this.skipInput.addEventListener('input', () => this.onChange?.());
    // The examples open into the viewport beside the dialog: the panel body is
    // a fixed-width scroller, which would clip them — and they clear the whole
    // dialog, not just the icon sitting a label's width inside it.
    this.skipHelp = new HelpPopover(
      container, this.role('skip-help'), SKIP_HELP_HTML, { clearOf: this.body },
    );
    // The one plain text field in the dialog — no ExpressionField owns its
    // keyboard, so Enter is wired to Apply the way every other field's is.
    this.skipInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onApply?.();
      }
    });
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
    const kind = this.kindSelect.value;
    return kind === 'circular' || kind === 'pattern' ? kind : 'linear';
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
    this.skipInput.value = '';
    this.setTargets([]);
    this.setPattern(null);
    this.setPatternAvailable(true);
    // The empty solids list is the first thing to fill — its slot opens
    // armed, taking whole-shape picks right away.
    this.armSlot('targets');
    this.syncSpacingLabels();
    this.syncType();
    this.shell.show();
  }

  /**
   * Closing the dialog takes the help popover with it — an anchor hidden out
   * from under the pointer never gets its `mouseleave`.
   */
  hide(): void {
    this.skipHelp.hide();
    super.hide();
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
    /** The statement's own skip list; null when it names none. */
    skip: number[][] | null;
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
    this.skipInput.value = state.skip ? formatSkipEntries(state.skip) : '';
    this.axisSlots.get(1)!.seedKeep(state.axisLabels[0] ?? null);
    this.axisSlots.get(2)!.seedKeep(state.axisLabels[1] ?? null);
    this.setTargets([]);
    this.setPattern(null);
    this.setPatternAvailable(true);
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

  /**
   * Re-find a connector axis after a re-render, by its site — the
   * connector sibling of {@link setOptions}; a connector the scene lost
   * falls back to the pick prompt (or the statement's own axis in edit mode).
   */
  setConnectorOptions(connectors: readonly ConnectorOption[]): void {
    for (const direction of [1, 2] as const) {
      this.axisSlots.get(direction)!.setConnectorOptions(connectors);
    }
  }

  /**
   * The Pattern slot's chip — the repeat the copies follow — or its prompt
   * while none is chosen.
   */
  setPattern(chip: PickSlotChip | null): void {
    this.patternSlot.setChips(chip ? [chip] : []);
    this.patternSlot.setPrompt(chip ? null : 'Pick a repeat in the timeline, or a feature it repeated');
  }

  /**
   * Offer "Along a repeat" only while every target is a connector — the form
   * copies nothing else. The service keeps solids out while it is chosen.
   */
  setPatternAvailable(available: boolean): void {
    this.patternOption.disabled = !available;
    this.patternOption.title = available
      ? "Copy connectors onto a repeat's instances — copy(pattern, …)"
      : 'Along a repeat copies connectors only — remove the solid targets first';
  }

  /** Render the target chips — numbered, the copy's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : this.targetsPrompt);
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
   * A connector picked as the axis (a gizmo or a connector row) — it lands
   * in the armed direction's slot, standing for its Z axis. No change event
   * fires.
   */
  selectConnectorAxis(option: ConnectorOption): void {
    const direction = this.armedAxis;
    this.axisSlots.get(direction)!.selectConnector(option);
    this.armSlot(direction === 2 ? 'axis2' : 'axis1');
  }

  /**
   * A world axis clicked in the viewport — it lands in the armed direction's
   * slot. No change event fires.
   */
  selectStandardAxis(axis: 'x' | 'y' | 'z'): void {
    const direction = this.armedAxis;
    this.axisSlots.get(direction)!.selectStandard(axis);
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
    if (kind === 'pattern') {
      return { kind };
    }
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
      const skip = this.readSkip(directions.map(d => typeof d.count === 'number' ? d.count : null));
      if ('error' in skip) {
        return skip;
      }
      return {
        kind, spacingMode, centered: this.centeredInput.checked, directions, skip,
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
    const skip = this.readSkip([typeof count.value === 'number' ? count.value : null]);
    if ('error' in skip) {
      return skip;
    }
    return {
      kind, count: count.value, sweep: { mode, value: value.value }, skip,
      newVariables: collectNewVariables([count, value]),
    };
  }

  /**
   * The Skip field as index tuples, checked against the counts beside it —
   * naming an instance the pattern doesn't have is a typo, not a silent no-op.
   * A count still being typed as an expression stands in as `null` and is left
   * unchecked; the kernel ignores a stray index either way.
   */
  private readSkip(counts: (number | null)[]): number[][] | { error: string } {
    const entries = parseSkipEntries(this.skipInput.value, counts.length);
    if ('error' in entries) {
      return entries;
    }
    const range = skipRangeError(entries, counts);
    return range === null ? entries : { error: range };
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
    this.patternSlot.setArmed(slot === 'pattern');
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
    // Along a repeat takes the repeat and nothing numeric: every instance is
    // the repeat's.
    const following = kind === 'pattern';
    this.patternWrap.classList.toggle('hidden', !following);
    for (const row of [this.dir1Wrap, this.axisWrap, this.countRow, this.skipRow]) {
      row.classList.toggle('hidden', following);
      row.classList.toggle('flex', !following);
    }
    // The Direction 1 header and its box only earn their place when a second
    // direction can exist; circular shows the bare axis slot.
    this.dir1Header.classList.toggle('hidden', !linear);
    for (const cls of DIRECTION_GROUP_CLASSES) {
      this.dir1Wrap.classList.toggle(cls, linear);
    }
    this.spacingRow.classList.toggle('hidden', !linear);
    this.spacingRow.classList.toggle('flex', linear);
    this.sweepRow.classList.toggle('hidden', linear || following);
    this.sweepRow.classList.toggle('flex', !linear && !following);
    this.dir2Wrap.classList.toggle('hidden', !(linear && this.dir2));
    this.dir2Wrap.classList.toggle('flex', linear && this.dir2);
    this.addDirectionBtn.classList.toggle('hidden', !(linear && !this.dir2));
    this.centeredRow.classList.toggle('hidden', !linear);
    this.centeredRow.classList.toggle('flex', linear);
    // A grid skips cells, everything else skips instances — the placeholder
    // says which the field is taking right now.
    this.skipInput.placeholder = this.directions.length > 1 ? 'e.g. [1, 0], [2, 1]' : 'e.g. 1, 3';
    // Circular defaults its empty axis to the world Z axis; linear
    // directions stay an explicit pick.
    if (kind === 'circular' && !this.axisSlots.get(1)!.selection) {
      this.axisSlots.get(1)!.selectStandard('z');
    }
    // An armed Direction 2 slot the circular kind hides falls to Direction 1.
    if (!linear && this.armedSlot === 'axis2') {
      this.armSlot('axis1');
    }
  }
}
