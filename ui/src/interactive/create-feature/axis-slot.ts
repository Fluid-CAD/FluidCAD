import { AxisOption } from './axis-options';
import { keepChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';

export type StandardAxis = 'x' | 'y' | 'z';

const STANDARD_AXES: readonly StandardAxis[] = ['x', 'y', 'z'];

/**
 * An axis slot's state, shared by every axis-picking dialog: a standard axis
 * (a world axis clicked in the viewport, or a sketch datum axis in the 2D
 * dialogs), an existing axis statement, a picked edge (the service owns the
 * entity), or — edit mode only — the statement's own axis expression kept
 * verbatim.
 */
export type AxisSelection =
  | { kind: 'standard'; axis: StandardAxis }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'keep' };

/**
 * The axis picker every axis-consuming dialog shares: a single-chip PickSlot
 * owning the {@link AxisSelection} state machine — rendering the chip per
 * state, re-matching an axis-statement choice after re-renders,
 * seeding/reverting to the edited statement's own axis (a standard literal
 * like `'z'` reads as the standard selection itself), and tracking the
 * picked-edge chip. Every pick comes from the viewport or the timeline: the
 * world axes shown while the slot is armed, an axis statement's line, or a
 * solid edge. The panel owns arming policy and the service owns scene data
 * and the edge entity.
 */
export class AxisSlotControl {
  /** The slot was clicked — the panel arms this slot. */
  onArm?: () => void;
  /** A gesture changed the selection (the chip's ✕). */
  onChange?: () => void;
  /** The selection left edge mode via a gesture — the service drops the entity. */
  onModeChange?: () => void;

  private readonly slot: PickSlot;
  private state: AxisSelection | null = null;
  /** The edited statement's own axis text; null in create mode. */
  private keepLabel: string | null = null;
  /** The picked-edge chip label the service pushed. */
  private edgeLabel: string | null = null;

  constructor(
    slotHost: HTMLElement,
    private readonly opts: {
      label?: string;
      /** The chosen-standard chip's label; default `World X axis`. */
      chipLabel?: (axis: StandardAxis) => string;
      /**
       * How a kept statement axis reads back as a standard selection — the
       * capture group is the axis letter. Default matches the world-axis
       * string literals (`'z'`); the 2D dialogs pass an `xAxis()` matcher.
       */
      keepMatcher?: RegExp;
      /**
       * The axes a kept text may read back as; default the three world
       * axes. The 2D dialogs, whose datums are the sketch's X and Y, name
       * those two so a kept `xAxis()` lands on its standard chip.
       */
      keepAxes?: readonly StandardAxis[];
      /** The empty slot's pick prompt. */
      prompt?: string;
    } = {},
  ) {
    this.slot = new PickSlot(slotHost, { label: opts.label ?? 'Axis', multiple: false });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own axis (a re-pick is undone, never the axis itself).
      this.state = this.fallbackState();
      this.render();
      this.onModeChange?.();
      this.onChange?.();
    };
    this.render();
  }

  get selection(): AxisSelection | null {
    return this.state;
  }

  /** Fresh create-mode arming: no keep label, the empty pick prompt. */
  reset(): void {
    this.keepLabel = null;
    this.edgeLabel = null;
    this.state = null;
    this.render();
  }

  /**
   * Seed the edited statement's own axis (edit mode): a standard world-axis
   * literal (`'z'`) reads as the standard selection itself, so the chip
   * reads "World Z axis" and the viewport axis lights up; anything else (a
   * variable, an axis() call) stays a verbatim "Current: …" keep.
   */
  seedKeep(label: string | null): void {
    this.keepLabel = label;
    this.edgeLabel = null;
    this.state = this.fallbackState();
    this.render();
  }

  /** Clear the slot outright (a removed repeat direction); no events fire. */
  clear(): void {
    this.state = null;
    this.render();
  }

  /** Re-seed the kept statement axis (a re-added repeat direction). */
  restoreFallback(): void {
    this.state = this.fallbackState();
    this.render();
  }

  /**
   * Refresh the offered axis statements after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that vanished
   * falls back to the statement's own axis in edit mode, or to the pick
   * prompt. Standard-axis and picked-edge states are scene-independent and
   * survive as they are (the service re-validates edge picks itself).
   */
  setOptions(axes: AxisOption[]): void {
    if (this.state?.kind === 'axis') {
      const prev = this.state.option;
      const match = axes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.state = match ? { kind: 'axis', option: match } : this.fallbackState();
    }
    this.render();
  }

  /** An axis picked in 3D or the timeline; no events fire. */
  selectOption(option: AxisOption): void {
    this.state = { kind: 'axis', option };
    this.render();
  }

  /**
   * A standard axis: a world axis clicked in the viewport, a sketch datum
   * pick, or a create-mode default. No events fire — the service drops any
   * picked edge and schedules the preview itself.
   */
  selectStandard(axis: StandardAxis): void {
    this.state = { kind: 'standard', axis };
    this.render();
  }

  /**
   * The picked-edge chip (the service owns the entity); null clears it —
   * back to the statement's own axis (edit mode), else the prompt.
   */
  setEdgeChip(label: string | null): void {
    this.edgeLabel = label;
    if (label !== null) {
      this.state = { kind: 'edge' };
    } else if (this.state?.kind === 'edge') {
      this.state = this.fallbackState();
    }
    this.render();
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** The statement-axis state a cleared slot reverts to; null in create mode. */
  private fallbackState(): AxisSelection | null {
    if (this.keepLabel === null) {
      return null;
    }
    const matcher = this.opts.keepMatcher ?? /^['"]([xyz])['"]$/;
    const standard = this.keepLabel.trim().match(matcher);
    const keepAxes = this.opts.keepAxes ?? STANDARD_AXES;
    if (standard && keepAxes.includes(standard[1] as StandardAxis)) {
      return { kind: 'standard', axis: standard[1] as StandardAxis };
    }
    return { kind: 'keep' };
  }

  /** The slot: one chip (the chosen axis), or the pick prompt. */
  private render(): void {
    const state = this.state;
    if (state?.kind === 'keep') {
      this.slot.setChips([keepChip(this.keepLabel ?? '')]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.slot.setChips([{
        label: this.opts.chipLabel?.(state.axis) ?? `World ${state.axis.toUpperCase()} axis`,
        badge: '●',
        removable: true,
      }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'axis') {
      this.slot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'edge') {
      this.slot.setChips([{ label: this.edgeLabel ?? 'Picked edge', badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips([]);
      this.slot.setPrompt(this.opts.prompt ?? 'Pick a world axis, an axis or an edge');
    }
  }
}
