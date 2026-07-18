import { PanelShell } from './panel-controls';
import { AxisOption } from './axis-options';
import { PlaneOption } from './plane-bases';
import { sourceChip } from './sketch-profiles';
import { PickSlot, PickSlotChip } from '../pick-slot';

export type RepeatType = 'linear' | 'circular' | 'mirror' | 'rotate';

/** The linear directions the panel offers — Direction 1 and an optional 2. */
export type RepeatDirection = 1 | 2;

/** The slot picks land in — the one last clicked (the sweep/loft idiom). */
export type RepeatArmedSlot = 'targets' | 'axis1' | 'axis2' | 'plane';

/**
 * An axis slot's state: a standard world axis (the X/Y/Z quick buttons), an
 * existing axis statement, a picked edge (the service owns the entity), or —
 * edit mode only — the kept statement axis at `sourceIndex` of its parsed
 * `axisTexts`, preserved verbatim.
 */
export type RepeatAxisSelection =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'keep'; sourceIndex: number };

/**
 * The mirror-plane slot's state: a standard origin plane (its viewport quad),
 * an existing plane feature, a picked face (the service owns the entity), or
 * — edit mode only — the kept statement plane, preserved verbatim.
 */
export type RepeatPlaneSelection =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; option: PlaneOption }
  | { kind: 'face' }
  | { kind: 'keep' };

/** Validated form values, or the message to show when a field is invalid. */
export type RepeatValues =
  | {
      kind: 'linear';
      spacingMode: 'offset' | 'length';
      centered: boolean;
      /** Count/value per active direction; the axes ride the service. */
      directions: { count: number; value: number }[];
    }
  | { kind: 'circular'; count: number; sweep: { mode: 'angle' | 'offset'; value: number } }
  | { kind: 'mirror' }
  | { kind: 'rotate'; angle: number }
  | { error: string };

const STANDARD_AXES = ['x', 'y', 'z'] as const;

/**
 * The repeat dialog: a Linear / Circular / Mirror / Rotate type dropdown
 * (the repeat kind), the features slot — filled ONLY from timeline clicks,
 * one numbered chip per feature being repeated — plus the kind's inputs.
 * Linear shows a Direction 1 group (axis slot + X/Y/Z quick buttons, Total
 * Count, the shared Offset/Total spacing mode with its value) and an "Add
 * second direction" button revealing a Direction 2 group with its own axis,
 * count and value (its ✕ removes it) — the Fusion-style two-direction
 * pattern; more axes stay a hand-written-code affair. Circular and Rotate
 * reuse the Direction 1 axis slot alone; Mirror swaps it for the plane slot
 * (an origin-plane quad, a plane feature, or a picked face). Exactly one
 * slot is ARMED at a time — clicked to activate, marked by the primary
 * border (the sweep/loft idiom) — and the viewer's pick channels follow it:
 * an armed axis/plane slot takes the 3D picks, the armed Features slot
 * turns scene picking off (features come from the timeline). Timeline rows
 * are typed and always route, re-arming their slot. Pure DOM + form state —
 * the service owns scene data, the picked entities, previews, and the apply
 * call.
 */
export class RepeatPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The type dropdown changed — the service re-aims the viewer pick channels. */
  onTypeChange?: () => void;
  /** The target chip at `index` was removed. */
  onRemoveTarget?: (index: number) => void;
  /** An axis slot left edge mode (✕, a standard/axis pick) — drop its entity. */
  onAxisModeChange?: (direction: RepeatDirection) => void;
  /** The plane slot left face mode (✕, a standard/plane pick) — drop the entity. */
  onPlaneModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot picks land in — the one last clicked. */
  armedSlot: RepeatArmedSlot = 'targets';

  private shell: PanelShell;
  private kindSelect: HTMLSelectElement;
  private targetsSlot: PickSlot;
  private axisWrap: HTMLElement;
  private dir1Header: HTMLElement;
  private axisSlots = new Map<RepeatDirection, PickSlot>();
  private axisButtons = new Map<RepeatDirection, Map<'x' | 'y' | 'z', HTMLButtonElement>>();
  private planeWrap: HTMLElement;
  private planeSlot: PickSlot;
  private countRow: HTMLElement;
  private countInput: HTMLInputElement;
  private spacingRow: HTMLElement;
  private spacingModeSelect: HTMLSelectElement;
  private spacingInput: HTMLInputElement;
  private sweepRow: HTMLElement;
  private sweepModeSelect: HTMLSelectElement;
  private sweepInput: HTMLInputElement;
  private dir2Wrap: HTMLElement;
  private count2Input: HTMLInputElement;
  private value2Label: HTMLElement;
  private value2Input: HTMLInputElement;
  private addDirectionBtn: HTMLButtonElement;
  private centeredRow: HTMLElement;
  private centeredInput: HTMLInputElement;
  private angleRow: HTMLElement;
  private angleInput: HTMLInputElement;
  private applyBtn: HTMLButtonElement;

  private axisStates = new Map<RepeatDirection, RepeatAxisSelection | null>();
  private planeState: RepeatPlaneSelection | null = null;
  /** The Direction 2 group is active (linear only). */
  private dir2 = false;
  /** Edit mode: slots start on (and revert to) "Current: …" keep chips. */
  private editMode = false;
  /** The statement's own axis texts, one keep-chip label per position. */
  private keepAxisLabels: string[] = [];
  /** The statement's own mirror-plane text, or null when it has none. */
  private keepPlaneLabel: string | null = null;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-repeat-panel', 'Repeat mode', '/icons/copy-linear.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <label class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Type</span>
        <select data-role="kind" class="select select-sm select-bordered w-full text-xs">
          <option value="linear" title="Repeat along one or two axes — repeat('linear', …)">Linear</option>
          <option value="circular" title="Repeat around an axis — repeat('circular', …)">Circular</option>
          <option value="mirror" title="Mirror across a plane — repeat('mirror', …)">Mirror</option>
          <option value="rotate" title="Rotated clone around an axis — repeat('rotate', …)">Rotate</option>
        </select>
      </label>
      <div data-role="targets-slot"></div>
      <div data-role="axis-wrap" class="flex flex-col gap-1.5">
        <span data-role="dir1-header" class="text-base-content/70 font-medium">Direction 1</span>
        <div data-role="axis-slot-1"></div>
        <div data-role="axis-buttons-1" class="join w-full"></div>
      </div>
      <div data-role="plane-wrap" class="hidden flex-col gap-1.5">
        <div data-role="plane-slot"></div>
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
        title="Repeat along a second axis too — repeat('linear', [a1, a2], …)">+ Add second direction</button>
      <label data-role="centered-row" class="flex items-center justify-between cursor-pointer"
        title="Center the pattern on the original instance">
        <span class="text-base-content/70">Centered</span>
        <input data-role="centered" type="checkbox" class="toggle toggle-sm toggle-primary" />
      </label>
      <label data-role="angle-row" class="hidden flex-col gap-1.5" title="Rotation angle in degrees">
        <span class="text-base-content/70">Angle (°)</span>
        <input data-role="angle" type="number" step="5" value="90"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.kindSelect = this.shell.body.querySelector('[data-role="kind"]')!;
    this.kindSelect.addEventListener('change', () => {
      this.syncType();
      this.onTypeChange?.();
      this.onChange?.();
    });

    this.targetsSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="targets-slot"]')!,
      { label: 'Features', multiple: true },
    );
    this.targetsSlot.onArm = () => this.armSlot('targets');
    this.targetsSlot.onRemove = (index) => this.onRemoveTarget?.(index);

    this.axisWrap = this.shell.body.querySelector('[data-role="axis-wrap"]')!;
    this.dir1Header = this.shell.body.querySelector('[data-role="dir1-header"]')!;
    for (const direction of [1, 2] as const) {
      const slot = new PickSlot(
        this.shell.body.querySelector(`[data-role="axis-slot-${direction}"]`)!,
        { label: 'Axis', multiple: false },
      );
      slot.onArm = () => this.armSlot(direction === 2 ? 'axis2' : 'axis1');
      slot.onRemove = () => {
        // Create mode: back to the prompt; edit mode: back to the
        // statement's own axis (a re-pick is undone, never the axis itself).
        this.axisStates.set(direction, this.statementAxisState(direction));
        this.renderAxis(direction);
        this.onAxisModeChange?.(direction);
        this.onChange?.();
      };
      this.axisSlots.set(direction, slot);
      this.axisStates.set(direction, null);

      // The world-axis quick row: one click sets its direction's slot
      // without a 3D pick.
      const buttonsHost = this.shell.body.querySelector(`[data-role="axis-buttons-${direction}"]`)!;
      const buttons = new Map<'x' | 'y' | 'z', HTMLButtonElement>();
      for (const axis of STANDARD_AXES) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm join-item flex-1 font-normal';
        btn.textContent = axis.toUpperCase();
        btn.title = `Repeat along the world ${axis.toUpperCase()} axis`;
        btn.addEventListener('click', () => {
          this.axisStates.set(direction, { kind: 'standard', axis });
          this.armSlot(direction === 2 ? 'axis2' : 'axis1');
          this.renderAxis(direction);
          this.onAxisModeChange?.(direction);
          this.onChange?.();
        });
        buttonsHost.appendChild(btn);
        buttons.set(axis, btn);
      }
      this.axisButtons.set(direction, buttons);
    }

    this.planeWrap = this.shell.body.querySelector('[data-role="plane-wrap"]')!;
    this.planeSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="plane-slot"]')!,
      { label: 'Plane', multiple: false },
    );
    this.planeSlot.onArm = () => this.armSlot('plane');
    this.planeSlot.onRemove = () => {
      this.planeState = this.statementPlaneState();
      this.renderPlane();
      this.onPlaneModeChange?.();
      this.onChange?.();
    };

    this.countRow = this.shell.body.querySelector('[data-role="count-row"]')!;
    this.countInput = this.shell.body.querySelector('[data-role="count"]')!;
    this.spacingRow = this.shell.body.querySelector('[data-role="spacing-row"]')!;
    this.spacingModeSelect = this.shell.body.querySelector('[data-role="spacing-mode"]')!;
    this.spacingInput = this.shell.body.querySelector('[data-role="spacing"]')!;
    this.sweepRow = this.shell.body.querySelector('[data-role="sweep-row"]')!;
    this.sweepModeSelect = this.shell.body.querySelector('[data-role="sweep-mode"]')!;
    this.sweepInput = this.shell.body.querySelector('[data-role="sweep"]')!;
    this.dir2Wrap = this.shell.body.querySelector('[data-role="dir2-wrap"]')!;
    this.count2Input = this.shell.body.querySelector('[data-role="count2"]')!;
    this.value2Label = this.shell.body.querySelector('[data-role="value2-label"]')!;
    this.value2Input = this.shell.body.querySelector('[data-role="value2"]')!;
    this.addDirectionBtn = this.shell.body.querySelector('[data-role="add-direction"]')!;
    this.centeredRow = this.shell.body.querySelector('[data-role="centered-row"]')!;
    this.centeredInput = this.shell.body.querySelector('[data-role="centered"]')!;
    this.angleRow = this.shell.body.querySelector('[data-role="angle-row"]')!;
    this.angleInput = this.shell.body.querySelector('[data-role="angle"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.addDirectionBtn.addEventListener('click', () => {
      this.dir2 = true;
      // A re-added direction restores its kept statement axis (edit mode).
      if (!this.axisStates.get(2)) {
        this.axisStates.set(2, this.statementAxisState(2));
        this.renderAxis(2);
      }
      // The fresh direction is the one being composed — its slot takes the
      // next axis pick.
      this.armSlot('axis2');
      this.syncType();
      this.onChange?.();
    });
    this.shell.body.querySelector('[data-role="dir2-remove"]')!.addEventListener('click', () => {
      this.dir2 = false;
      this.axisStates.set(2, null);
      this.renderAxis(2);
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
    const numberInputs = [
      this.countInput, this.spacingInput, this.sweepInput,
      this.count2Input, this.value2Input, this.angleInput,
    ];
    for (const input of numberInputs) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.onApply?.();
        }
        e.stopPropagation();
      });
    }

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  get repeatType(): RepeatType {
    const value = this.kindSelect.value;
    return value === 'circular' || value === 'mirror' || value === 'rotate' ? value : 'linear';
  }

  /** Whether the current type takes an axis (everything but mirror). */
  get usesAxis(): boolean {
    return this.repeatType !== 'mirror';
  }

  /** The active linear directions: [1] or [1, 2]. */
  get directions(): RepeatDirection[] {
    return this.repeatType === 'linear' && this.dir2 ? [1, 2] : [1];
  }

  /** The direction whose axis slot takes the next 3D axis/edge pick. */
  get armedAxis(): RepeatDirection {
    return this.armedSlot === 'axis2' ? 2 : 1;
  }

  show(): void {
    // A fresh arming starts from defaults and empty slots — the previous
    // session's choices would otherwise be revived by source-line matching.
    this.editMode = false;
    this.keepAxisLabels = [];
    this.keepPlaneLabel = null;
    this.shell.setTitle(null);
    this.kindSelect.value = 'linear';
    this.axisStates.set(1, null);
    this.axisStates.set(2, null);
    this.planeState = null;
    this.dir2 = false;
    this.countInput.value = '3';
    this.spacingModeSelect.value = 'offset';
    this.spacingInput.value = '20';
    this.sweepModeSelect.value = 'angle';
    this.sweepInput.value = '360';
    this.count2Input.value = '2';
    this.value2Input.value = '20';
    this.centeredInput.checked = false;
    this.angleInput.value = '90';
    this.setTargets([]);
    this.renderAxis(1);
    this.renderAxis(2);
    this.renderPlane();
    // The empty features list is the first thing to fill — its slot opens
    // armed, and scene picking stays off until an input slot is clicked.
    this.armSlot('targets');
    this.syncSpacingLabels();
    this.syncType();
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /** Programmatic type choice (selection seeding); no change event fires. */
  setType(type: RepeatType): void {
    this.kindSelect.value = type;
    this.syncType();
  }

  /**
   * Open prefilled from an existing statement (edit mode). The axis/plane
   * slots start on "Current: …" chips that keep the statement's own
   * expressions verbatim (per direction, by position); re-sourcing is live
   * and a re-picked chip's ✕ reverts to the kept expression. Fields the
   * statement doesn't carry (a kind switch reveals them) seed with the
   * create defaults. The targets slot is seeded by the service.
   */
  showEdit(state: {
    kind: RepeatType;
    directions: { count: number; value: number }[] | null;
    spacingMode: 'offset' | 'length' | null;
    centered: boolean;
    count: number | null;
    sweep: { mode: 'angle' | 'offset'; value: number } | null;
    angle: number | null;
    /** Keep-chip labels, one per statement axis (`axisTexts`). */
    axisLabels: string[];
    /** Keep-chip label for the statement's mirror plane, or null. */
    planeLabel: string | null;
  }): void {
    this.editMode = true;
    this.keepAxisLabels = state.axisLabels;
    this.keepPlaneLabel = state.planeLabel;
    this.shell.setTitle('Edit repeat');
    this.kindSelect.value = state.kind;
    this.dir2 = (state.directions?.length ?? 0) === 2;
    this.countInput.value = String(
      state.kind === 'linear' ? state.directions?.[0]?.count ?? 3 : state.count ?? 3,
    );
    this.spacingModeSelect.value = state.spacingMode ?? 'offset';
    this.spacingInput.value = String(state.directions?.[0]?.value ?? 20);
    this.sweepModeSelect.value = state.sweep?.mode ?? 'angle';
    this.sweepInput.value = String(state.sweep?.value ?? 360);
    this.count2Input.value = String(state.directions?.[1]?.count ?? 2);
    this.value2Input.value = String(state.directions?.[1]?.value ?? 20);
    this.centeredInput.checked = state.centered;
    this.angleInput.value = String(state.angle ?? 90);
    this.axisStates.set(1, this.statementAxisState(1));
    this.axisStates.set(2, this.statementAxisState(2));
    this.planeState = this.statementPlaneState();
    this.setTargets([]);
    this.renderAxis(1);
    this.renderAxis(2);
    this.renderPlane();
    // The targets list is the seeded statement's — its slot opens armed like
    // create mode, ready to toggle features in the timeline.
    this.armSlot('targets');
    this.syncSpacingLabels();
    this.syncType();
    this.shell.show();
  }

  /**
   * A direction's statement-axis entry — what the slot seeds with and
   * reverts to in edit mode — or null when the statement has no axis at its
   * position (create mode, or a kind the statement's shape doesn't cover).
   * A standard world-axis literal (`'y'`) reads as the standard selection
   * itself, chip and quick-button state matching create mode; anything else
   * stays a verbatim "Current: …" keep.
   */
  private statementAxisState(direction: RepeatDirection): RepeatAxisSelection | null {
    const sourceIndex = direction - 1;
    if (!this.editMode || sourceIndex >= this.keepAxisLabels.length) {
      return null;
    }
    const standard = this.keepAxisLabels[sourceIndex].match(/^['"]([xyz])['"]$/);
    if (standard) {
      return { kind: 'standard', axis: standard[1] as 'x' | 'y' | 'z' };
    }
    return { kind: 'keep', sourceIndex };
  }

  /**
   * The plane slot's statement entry, or null when there is none. A standard
   * origin-plane literal (`'yz'`) reads as the standard selection itself.
   */
  private statementPlaneState(): RepeatPlaneSelection | null {
    if (!this.editMode || this.keepPlaneLabel === null) {
      return null;
    }
    const standard = this.keepPlaneLabel.match(/^['"](xy|xz|yz)['"]$/);
    if (standard) {
      return { kind: 'standard', plane: standard[1] as 'xy' | 'xz' | 'yz' };
    }
    return { kind: 'keep' };
  }

  /**
   * Refresh the offered axis/plane statements after a re-render, keeping the
   * current choices when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that vanished
   * falls back to the pick prompt. Standard and picked-entity states are
   * scene-independent and survive as they are (the service re-validates
   * entity picks itself).
   */
  setOptions(axes: AxisOption[], planes: PlaneOption[]): void {
    for (const direction of [1, 2] as const) {
      const state = this.axisStates.get(direction);
      if (state?.kind === 'axis') {
        const match = axes.find(o => o.filePath === state.option.filePath && o.line === state.option.line);
        this.axisStates.set(direction, match
          ? { kind: 'axis', option: match }
          : this.statementAxisState(direction));
      }
      this.renderAxis(direction);
    }
    if (this.planeState?.kind === 'plane') {
      const prev = this.planeState.option;
      const match = planes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.planeState = match ? { kind: 'plane', option: match } : this.statementPlaneState();
    }
    this.renderPlane();
  }

  /** Render the target chips — numbered, the repeat's argument order. */
  setTargets(chips: PickSlotChip[]): void {
    this.targetsSlot.setChips(chips.map((chip, index) => ({
      ...chip,
      badge: String(index + 1),
      removable: true,
    })));
    this.targetsSlot.setPrompt(chips.length > 0 ? null : 'Pick features in the timeline');
  }

  axisSelection(direction: RepeatDirection = 1): RepeatAxisSelection | null {
    return this.axisStates.get(direction) ?? null;
  }

  planeSelection(): RepeatPlaneSelection | null {
    return this.planeState;
  }

  /**
   * An axis picked in 3D or the timeline — it lands in the armed direction's
   * slot, arming it so the border tracks where the pick landed. No change
   * event fires.
   */
  selectAxis(option: AxisOption): void {
    const direction = this.armedAxis;
    this.axisStates.set(direction, { kind: 'axis', option });
    this.armSlot(direction === 2 ? 'axis2' : 'axis1');
    this.renderAxis(direction);
  }

  /**
   * A plane feature picked in 3D or the timeline; arms the plane slot so the
   * border tracks where the pick landed. No change event fires.
   */
  selectPlane(option: PlaneOption): void {
    this.planeState = { kind: 'plane', option };
    this.armSlot('plane');
    this.renderPlane();
  }

  /** An origin-plane quad picked in the viewport. No change event fires. */
  selectStandardPlane(plane: 'xy' | 'xz' | 'yz'): void {
    this.planeState = { kind: 'standard', plane };
    this.armSlot('plane');
    this.renderPlane();
  }

  /**
   * A direction's picked-edge chip (the service owns the entity); null
   * clears it back to the prompt.
   */
  setAxisEdgeChip(direction: RepeatDirection, label: string | null): void {
    if (label !== null) {
      this.axisStates.set(direction, { kind: 'edge' });
    } else if (this.axisStates.get(direction)?.kind === 'edge') {
      this.axisStates.set(direction, this.statementAxisState(direction));
    }
    this.renderAxis(direction, label ?? undefined);
  }

  /**
   * The plane slot's picked-face chip (the service owns the entity); null
   * clears it back to the prompt.
   */
  setPlaneFaceChip(label: string | null): void {
    if (label !== null) {
      this.planeState = { kind: 'face' };
    } else if (this.planeState?.kind === 'face') {
      this.planeState = this.statementPlaneState();
    }
    this.renderPlane(label ?? undefined);
  }

  values(): RepeatValues {
    const kind = this.repeatType;
    if (kind === 'mirror') {
      return { kind };
    }
    if (kind === 'rotate') {
      const angle = parseFloat(this.angleInput.value);
      if (!Number.isFinite(angle) || angle === 0) {
        return { error: 'Enter a nonzero rotation angle in degrees.' };
      }
      return { kind, angle };
    }
    if (kind === 'linear') {
      const spacingMode = this.spacingModeSelect.value === 'length' ? 'length' : 'offset';
      const directions: { count: number; value: number }[] = [];
      for (const direction of this.directions) {
        const countInput = direction === 1 ? this.countInput : this.count2Input;
        const valueInput = direction === 1 ? this.spacingInput : this.value2Input;
        const which = this.dir2 ? ` for direction ${direction}` : '';
        const count = parseFloat(countInput.value);
        if (!Number.isInteger(count) || count < 2) {
          return { error: `Enter a whole count of at least 2${which} (the original included).` };
        }
        const value = parseFloat(valueInput.value);
        if (!Number.isFinite(value) || value === 0) {
          return { error: `Enter a nonzero spacing distance${which}.` };
        }
        directions.push({ count, value });
      }
      return { kind, spacingMode, centered: this.centeredInput.checked, directions };
    }
    const count = parseFloat(this.countInput.value);
    if (!Number.isInteger(count) || count < 2) {
      return { error: 'Enter a whole count of at least 2 (the original included).' };
    }
    const value = parseFloat(this.sweepInput.value);
    if (!Number.isFinite(value) || value === 0) {
      return { error: 'Enter a nonzero sweep angle in degrees.' };
    }
    const mode = this.sweepModeSelect.value === 'offset' ? 'offset' : 'angle';
    return { kind, count, sweep: { mode, value } };
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

  /** A direction's axis slot: one chip (the chosen axis), or the prompt. */
  private renderAxis(direction: RepeatDirection, edgeLabel?: string): void {
    const slot = this.axisSlots.get(direction)!;
    const state = this.axisStates.get(direction);
    if (state?.kind === 'keep') {
      slot.setChips([{
        label: `Current: ${this.keepAxisLabels[state.sourceIndex] ?? ''}`,
        badge: '●',
        removable: false,
      }]);
      slot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      slot.setChips([{
        label: `World ${state.axis.toUpperCase()} axis`,
        badge: '●',
        removable: true,
      }]);
      slot.setPrompt(null);
    } else if (state?.kind === 'axis') {
      slot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      slot.setPrompt(null);
    } else if (state?.kind === 'edge') {
      slot.setChips([{ label: edgeLabel ?? 'Picked edge', badge: '●', removable: true }]);
      slot.setPrompt(null);
    } else {
      slot.setChips([]);
      slot.setPrompt('Pick an axis or edge');
    }
    for (const [axis, btn] of this.axisButtons.get(direction)!) {
      btn.classList.toggle('btn-soft', state?.kind === 'standard' && state.axis === axis);
      btn.classList.toggle('btn-primary', state?.kind === 'standard' && state.axis === axis);
    }
  }

  /** The plane slot: one chip (the chosen plane), or the pick prompt. */
  private renderPlane(faceLabel?: string): void {
    const state = this.planeState;
    if (state?.kind === 'keep') {
      this.planeSlot.setChips([{
        label: `Current: ${this.keepPlaneLabel ?? ''}`,
        badge: '●',
        removable: false,
      }]);
      this.planeSlot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.planeSlot.setChips([{
        label: `${state.plane.toUpperCase()} plane`,
        badge: '●',
        removable: true,
      }]);
      this.planeSlot.setPrompt(null);
    } else if (state?.kind === 'plane') {
      this.planeSlot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.planeSlot.setPrompt(null);
    } else if (state?.kind === 'face') {
      this.planeSlot.setChips([{ label: faceLabel ?? 'Picked face', badge: '●', removable: true }]);
      this.planeSlot.setPrompt(null);
    } else {
      this.planeSlot.setChips([]);
      this.planeSlot.setPrompt('Pick a plane or face');
    }
  }

  /**
   * Arm one slot: it wears the primary border and the viewer's pick
   * channels follow it — an armed axis/plane slot takes the 3D picks, the
   * armed Features slot turns scene picking off (features come from the
   * timeline). The service re-aims the channels on every actual change.
   */
  armSlot(slot: RepeatArmedSlot): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.targetsSlot.setArmed(slot === 'targets');
    this.axisSlots.get(1)!.setArmed(slot === 'axis1');
    this.axisSlots.get(2)!.setArmed(slot === 'axis2');
    this.planeSlot.setArmed(slot === 'plane');
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
    const kind = this.repeatType;
    const linear = kind === 'linear';
    const usesAxis = kind !== 'mirror';
    this.axisWrap.classList.toggle('hidden', !usesAxis);
    this.axisWrap.classList.toggle('flex', usesAxis);
    // The Direction 1 header only earns its row when a second direction can
    // exist; other kinds show the bare axis slot.
    this.dir1Header.classList.toggle('hidden', !linear);
    this.planeWrap.classList.toggle('hidden', kind !== 'mirror');
    this.planeWrap.classList.toggle('flex', kind === 'mirror');
    const usesCount = linear || kind === 'circular';
    this.countRow.classList.toggle('hidden', !usesCount);
    this.countRow.classList.toggle('flex', usesCount);
    this.spacingRow.classList.toggle('hidden', !linear);
    this.spacingRow.classList.toggle('flex', linear);
    this.sweepRow.classList.toggle('hidden', kind !== 'circular');
    this.sweepRow.classList.toggle('flex', kind === 'circular');
    this.dir2Wrap.classList.toggle('hidden', !(linear && this.dir2));
    this.dir2Wrap.classList.toggle('flex', linear && this.dir2);
    this.addDirectionBtn.classList.toggle('hidden', !(linear && !this.dir2));
    this.centeredRow.classList.toggle('hidden', !linear);
    this.centeredRow.classList.toggle('flex', linear);
    this.angleRow.classList.toggle('hidden', kind !== 'rotate');
    this.angleRow.classList.toggle('flex', kind === 'rotate');
    // An armed slot the new kind hides falls to the kind's input slot; the
    // Features slot stays armed across kinds.
    if (kind === 'mirror' && (this.armedSlot === 'axis1' || this.armedSlot === 'axis2')) {
      this.armSlot('plane');
    } else if (usesAxis && this.armedSlot === 'plane') {
      this.armSlot('axis1');
    } else if (!linear && this.armedSlot === 'axis2') {
      this.armSlot('axis1');
    }
  }
}
