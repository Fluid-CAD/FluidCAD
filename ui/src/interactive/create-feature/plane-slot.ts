import { PlaneOption } from './plane-bases';
import { keepChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';

export type StandardPlane = 'xy' | 'xz' | 'yz';

/**
 * A mirror-plane slot's state: a standard origin plane (its viewport quad),
 * an existing plane feature, a picked face (the service owns the entity), or
 * — edit mode only — the statement's own plane expression kept verbatim.
 */
export type PlaneSelection =
  | { kind: 'standard'; plane: StandardPlane }
  | { kind: 'plane'; option: PlaneOption }
  | { kind: 'face' }
  | { kind: 'keep' };

/**
 * The plane picker mirroring {@link AxisSlotControl} for plane-consuming
 * slots: a single-chip PickSlot owning the {@link PlaneSelection} state
 * machine. Standard planes arrive programmatically (their viewport quads,
 * not quick buttons); a standard literal like `'yz'` seeds as the standard
 * selection itself. The panel owns arming policy and the service owns scene
 * data and the face entity.
 */
export class PlaneSlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture changed the selection (the chip's ✕). */
  onChange?: () => void;
  /** The selection left face mode via a gesture — the service drops the entity. */
  onModeChange?: () => void;

  private readonly slot: PickSlot;
  private state: PlaneSelection | null = null;
  /** The edited statement's own plane text; null in create mode. */
  private keepLabel: string | null = null;
  /** The picked-face chip label the service pushed. */
  private faceLabel: string | null = null;

  constructor(slotHost: HTMLElement, opts: { label?: string } = {}) {
    this.slot = new PickSlot(slotHost, { label: opts.label ?? 'Plane', multiple: false });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own plane (a re-pick is undone, never the plane itself).
      this.state = this.fallbackState();
      this.render();
      this.onModeChange?.();
      this.onChange?.();
    };
    this.render();
  }

  get selection(): PlaneSelection | null {
    return this.state;
  }

  /** Fresh create-mode arming: no keep label, the empty pick prompt. */
  reset(): void {
    this.keepLabel = null;
    this.faceLabel = null;
    this.state = null;
    this.render();
  }

  /**
   * Seed the edited statement's own plane (edit mode): a standard
   * origin-plane literal (`'yz'`) reads as the standard selection itself;
   * anything else stays a verbatim "Current: …" keep. Null means the
   * statement carries no plane.
   */
  seedKeep(label: string | null): void {
    this.keepLabel = label;
    this.faceLabel = null;
    this.state = this.fallbackState();
    this.render();
  }

  /**
   * Refresh the offered plane features after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location). A choice that vanished falls back to the statement's
   * own plane in edit mode, or to the pick prompt.
   */
  setOptions(planes: PlaneOption[]): void {
    if (this.state?.kind === 'plane') {
      const prev = this.state.option;
      const match = planes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.state = match ? { kind: 'plane', option: match } : this.fallbackState();
    }
    this.render();
  }

  /** A plane feature picked in 3D or the timeline; no events fire. */
  selectOption(option: PlaneOption): void {
    this.state = { kind: 'plane', option };
    this.render();
  }

  /** An origin-plane quad picked in the viewport; no events fire. */
  selectStandard(plane: StandardPlane): void {
    this.state = { kind: 'standard', plane };
    this.render();
  }

  /**
   * The picked-face chip (the service owns the entity); null clears it —
   * back to the statement's own plane (edit mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    this.faceLabel = label;
    if (label !== null) {
      this.state = { kind: 'face' };
    } else if (this.state?.kind === 'face') {
      this.state = this.fallbackState();
    }
    this.render();
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** The statement-plane state a cleared slot reverts to; null in create mode. */
  private fallbackState(): PlaneSelection | null {
    if (this.keepLabel === null) {
      return null;
    }
    const standard = this.keepLabel.trim().match(/^['"](xy|xz|yz)['"]$/);
    if (standard) {
      return { kind: 'standard', plane: standard[1] as StandardPlane };
    }
    return { kind: 'keep' };
  }

  /** The slot: one chip (the chosen plane), or the pick prompt. */
  private render(): void {
    const state = this.state;
    if (state?.kind === 'keep') {
      this.slot.setChips([keepChip(this.keepLabel ?? '')]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.slot.setChips([{
        label: `${state.plane.toUpperCase()} plane`,
        badge: '●',
        removable: true,
      }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'plane') {
      this.slot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'face') {
      this.slot.setChips([{ label: this.faceLabel ?? 'Picked face', badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips([]);
      this.slot.setPrompt('Pick a plane or face');
    }
  }
}
