import { SketchProfileOption, keepSketchChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';

/** A sketch slot's state, `keep` included (edit mode only). */
export type SketchSlotSelection =
  | { kind: 'keep' }
  | { kind: 'sketch'; option: SketchProfileOption };

/**
 * The single-sketch picker the profile slots share (extrude, revolve, sweep,
 * wrap): a single-chip PickSlot owning the option list and its selection —
 * defaulting to the first offered sketch (the active one, in sketch mode),
 * re-matching the choice after re-renders (by kind + source location — scene
 * ids change every render), seeding/reverting to the edited statement's own
 * profile, and wearing the shared empty-slot prompts. The panel owns arming
 * policy.
 */
export class SketchSlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture changed the selection (the chip's ✕). */
  onChange?: () => void;

  private readonly slot: PickSlot;
  private optionList: SketchProfileOption[] = [];
  private state: SketchSlotSelection | null = null;
  /** Edit mode: the statement's own profile text (null when implicit). */
  private keep: { label: string | null } | null = null;

  constructor(host: HTMLElement, opts: { label?: string; boxed?: boolean } = {}) {
    this.slot = new PickSlot(host, {
      label: opts.label ?? 'Sketch',
      multiple: false,
      boxed: opts.boxed,
    });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own profile (a re-pick is undone, never the profile itself).
      this.state = this.fallbackState();
      this.render();
      this.onChange?.();
    };
    this.render();
  }

  /** The offered sketches, as last set. */
  get options(): SketchProfileOption[] {
    return this.optionList;
  }

  get editMode(): boolean {
    return this.keep !== null;
  }

  /**
   * Fresh create-mode arming: the offered sketches with the first one (the
   * active sketch, in sketch mode) preselected — or the pick prompt.
   */
  reset(options: SketchProfileOption[]): void {
    this.keep = null;
    this.state = null;
    this.optionList = options;
    if (options.length > 0) {
      this.state = { kind: 'sketch', option: options[0] };
    }
    this.render();
  }

  /** Seed the edited statement's own profile (edit mode); label null = implicit. */
  seedKeep(label: string | null): void {
    this.keep = { label };
    this.optionList = [];
    this.state = { kind: 'keep' };
    this.render();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping the current
   * choice when the same sketch is still offered. A choice that vanished
   * falls back to the "Current: …" chip in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[]): void {
    this.optionList = options;
    if (this.state?.kind === 'sketch') {
      const prev = this.state.option;
      const match = options.find(o => o.kind === prev.kind
        && (o.kind === 'active' || (o.filePath === prev.filePath && o.line === prev.line)));
      this.state = match ? { kind: 'sketch', option: match } : this.fallbackState();
    }
    this.render();
  }

  selection(): SketchSlotSelection | null {
    return this.state;
  }

  selectedOption(): SketchProfileOption | null {
    return this.state?.kind === 'sketch' ? this.state.option : null;
  }

  /** A timeline pick by option index; no events fire. */
  selectIndex(index: number): boolean {
    const option = this.optionList[index];
    if (!option) {
      return false;
    }
    this.state = { kind: 'sketch', option };
    this.render();
    return true;
  }

  /**
   * A timeline/wire pick by source location; returns false when the sketch
   * isn't among the offered options. No events fire.
   */
  selectByLocation(filePath: string, line: number): boolean {
    const option = this.optionList.find(o => o.filePath === filePath && o.line === line);
    if (!option) {
      return false;
    }
    this.state = { kind: 'sketch', option };
    this.render();
    return true;
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** The keep state a cleared slot reverts to; null in create mode. */
  private fallbackState(): SketchSlotSelection | null {
    return this.keep !== null ? { kind: 'keep' } : null;
  }

  /** The slot: one chip (the chosen sketch), or the pick prompt. */
  private render(): void {
    const state = this.state;
    if (state?.kind === 'keep') {
      this.slot.setChips([keepSketchChip(this.keep?.label ?? null)]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips(state
        ? [sourceChip(state.option, { badge: '●', removable: true })]
        : []);
      this.slot.setPrompt(state
        ? null
        : this.optionList.length > 0 || this.editMode
          ? 'Pick a sketch'
          : 'No sketch — create one first');
    }
  }
}
