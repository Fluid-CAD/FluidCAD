import { SketchProfileOption, keepChip, keepSketchChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';
import { RegionPickControl } from './region-pick-control';
import { consumedReveal } from './consumed-reveal';


/** A sketch slot's state, `keep` included (edit mode only). */
export type SketchSlotSelection =
  | { kind: 'keep' }
  | { kind: 'sketch'; option: SketchProfileOption };

/**
 * The state of a slot that also takes a face (`faces`): `face` is one picked
 * in the viewport in place of a sketch — the owning service keeps the entity.
 */
export type ProfileSlotSelection = SketchSlotSelection | { kind: 'face'; label: string };

/**
 * The single-sketch picker the profile slots share (extrude, revolve, sweep,
 * wrap): a single-chip PickSlot owning the option list and its selection —
 * defaulting to the first offered sketch (the active one, in sketch mode),
 * re-matching the choice after re-renders (by kind + source location — scene
 * ids change every render), seeding/reverting to the edited statement's own
 * profile, and wearing the shared empty-slot prompts. The panel owns arming
 * policy. `regions` adds the region row under the chip — the "Pick regions"
 * link and pick count the swept features carry (a rib's spine has no
 * regions to pick). `faces` lets the slot hold a picked face instead of a
 * sketch (extrude sweeps a face as it stands): the service owns the entity
 * and pushes its chip through {@link selectFace}.
 */
export class SketchSlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture changed the selection (the chip's ✕). */
  onChange?: () => void;

  /** The region row, for the dialogs that opted in; the service drives it. */
  readonly regions: RegionPickControl | null;

  private readonly slot: PickSlot;
  private readonly host: HTMLElement;
  private optionList: SketchProfileOption[] = [];
  private state: ProfileSlotSelection | null = null;
  /** The choice a picked face replaced — what its ✕ goes back to. */
  private beforeFace: ProfileSlotSelection | null = null;
  /** Edit mode: the statement's own profile text (null when implicit). */
  private keep: { label: string | null; face: boolean } | null = null;
  /** The slot takes a picked face as well as a sketch. */
  private readonly faces: boolean;

  constructor(host: HTMLElement, opts: { label?: string; boxed?: boolean; regions?: boolean; faces?: boolean } = {}) {
    this.host = host;
    this.faces = opts.faces === true;
    this.slot = new PickSlot(host, {
      label: opts.label ?? 'Sketch',
      multiple: false,
      boxed: opts.boxed,
    });
    if (opts.regions) {
      // Below the chip list, inside the slot host: a click on the row arms
      // the slot like a click on the chip does.
      const row = document.createElement('div');
      host.appendChild(row);
      this.regions = new RegionPickControl(row);
    } else {
      this.regions = null;
    }
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      // A picked face gives the slot back to the sketch it replaced.
      // Otherwise, create mode: back to the prompt; edit mode: back to the
      // statement's own profile (a re-pick is undone, never the profile).
      this.state = this.state?.kind === 'face' ? this.restoredState() : this.fallbackState();
      this.beforeFace = null;
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
   * Fresh create-mode arming: the offered sketches with the active sketch
   * (in sketch mode) or else the last one preselected — or the pick prompt.
   */
  reset(options: SketchProfileOption[]): void {
    this.keep = null;
    this.state = null;
    this.beforeFace = null;
    this.optionList = options;
    // The default pick is the active sketch, else the last sketch in scene
    // order — the one a bare `extrude()` would take, used or not (a region
    // extrude is usually followed by another on the same sketch).
    const preset = options[0]?.kind === 'active'
      ? options[0]
      : options.filter(o => o.feature === 'sketch').at(-1) ?? options[0];
    if (preset) {
      this.state = { kind: 'sketch', option: preset };
    }
    this.render();
  }

  /**
   * Seed the edited statement's own profile (edit mode); label null =
   * implicit. `face` marks a profile that is not a sketch — a face selector
   * (`extrude(10, e.endFaces())`) — so its chip reads as the expression.
   */
  seedKeep(label: string | null, face = false): void {
    this.keep = { label, face: face && label !== null };
    this.optionList = [];
    this.state = { kind: 'keep' };
    this.beforeFace = null;
    this.render();
  }

  /**
   * A face was picked in the viewport as the profile (the service owns the
   * entity). No events fire.
   */
  selectFace(label: string): void {
    if (this.state?.kind !== 'face') {
      this.beforeFace = this.state;
    }
    this.state = { kind: 'face', label };
    this.render();
  }

  /**
   * Drop the picked face — it was toggled off, or its shape died with a
   * re-render — back to the choice it replaced. No events fire.
   */
  clearFace(): void {
    if (this.state?.kind !== 'face') {
      return;
    }
    this.state = this.restoredState();
    this.beforeFace = null;
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
      this.state = this.rematched(this.state);
    }
    // The sketch a picked face replaced follows the options too.
    if (this.beforeFace?.kind === 'sketch') {
      this.beforeFace = this.rematched(this.beforeFace);
    }
    this.render();
  }

  /** The same sketch among the current options, else the fallback. */
  private rematched(state: { kind: 'sketch'; option: SketchProfileOption }): SketchSlotSelection | null {
    const prev = state.option;
    const match = this.optionList.find(o => o.kind === prev.kind
      && (o.kind === 'active' || (o.filePath === prev.filePath && o.line === prev.line)));
    return match ? { kind: 'sketch', option: match } : this.fallbackState();
  }

  /** The sketch choice; null too while the slot holds a picked face. */
  selection(): SketchSlotSelection | null {
    return this.state?.kind === 'face' ? null : this.state;
  }

  /** The full state of a slot that takes faces, a picked face included. */
  profileSelection(): ProfileSlotSelection | null {
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
    this.beforeFace = null;
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
    this.beforeFace = null;
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

  /** What a dropped face hands the slot back to: the choice it replaced. */
  private restoredState(): ProfileSlotSelection | null {
    return this.beforeFace ?? this.fallbackState();
  }

  /** The empty slot's prompt. */
  private emptyPrompt(): string {
    if (this.faces) {
      return 'Pick a sketch or a face';
    }
    return this.optionList.length > 0 || this.editMode ? 'Pick a sketch' : 'No sketch — create one first';
  }

  /** The slot: one chip (the chosen sketch), or the pick prompt. */
  private render(): void {
    const state = this.state;
    // A consumed sketch picked here is drawn for as long as the slot holds it.
    consumedReveal.set(this, this.host, state?.kind === 'sketch' && state.option.consumer ? state.option : null);

    if (state?.kind === 'keep') {
      this.slot.setChips([this.keep?.face ? keepChip(this.keep.label!) : keepSketchChip(this.keep?.label ?? null)]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'face') {
      this.slot.setChips([{ label: state.label, badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips(state
        ? [sourceChip(state.option, { badge: '●', removable: true })]
        : []);
      this.slot.setPrompt(state ? null : this.emptyPrompt());
    }
  }
}
