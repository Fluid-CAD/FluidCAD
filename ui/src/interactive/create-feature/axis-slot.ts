import { AxisOption } from './axis-options';
import { keepChip, sourceChip } from './sketch-profiles';
import { PickSlot } from '../pick-slot';

export type StandardAxis = 'x' | 'y' | 'z';

const STANDARD_AXES: readonly StandardAxis[] = ['x', 'y', 'z'];

/**
 * An axis slot's state, shared by every axis-picking dialog: a standard world
 * axis (the X/Y/Z quick buttons), an existing axis statement, a picked edge
 * (the service owns the entity), or — edit mode only — the statement's own
 * axis expression kept verbatim.
 */
export type AxisSelection =
  | { kind: 'standard'; axis: StandardAxis }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'keep' };

/**
 * The axis picker every axis-consuming dialog shares: a single-chip PickSlot
 * with the X/Y/Z quick-button row under it, owning the {@link AxisSelection}
 * state machine — rendering the chip per state, re-matching an axis-statement
 * choice after re-renders, seeding/reverting to the edited statement's own
 * axis (a standard literal like `'z'` reads as the standard selection itself,
 * lighting its quick button), and tracking the picked-edge chip. The panel
 * owns arming policy and the service owns scene data and the edge entity.
 */
export class AxisSlotControl {
  /** The slot or a quick button was clicked — the panel arms this slot. */
  onArm?: () => void;
  /** A gesture changed the selection (a quick button, the chip's ✕). */
  onChange?: () => void;
  /** The selection left edge mode via a gesture — the service drops the entity. */
  onModeChange?: () => void;

  private readonly slot: PickSlot;
  private readonly buttons = new Map<StandardAxis, HTMLButtonElement>();
  private state: AxisSelection | null = null;
  /** The edited statement's own axis text; null in create mode. */
  private keepLabel: string | null = null;
  /** The picked-edge chip label the service pushed. */
  private edgeLabel: string | null = null;

  constructor(
    slotHost: HTMLElement,
    buttonsHost: HTMLElement,
    opts: { buttonTitle: (axis: string) => string; label?: string },
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

    // The world-axis quick row: one click sets the slot without a 3D pick.
    for (const axis of STANDARD_AXES) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm join-item flex-1 font-normal';
      btn.textContent = axis.toUpperCase();
      btn.title = opts.buttonTitle(axis.toUpperCase());
      btn.addEventListener('click', () => {
        this.state = { kind: 'standard', axis };
        this.onArm?.();
        this.render();
        this.onModeChange?.();
        this.onChange?.();
      });
      buttonsHost.appendChild(btn);
      this.buttons.set(axis, btn);
    }
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
   * literal (`'z'`) reads as the standard selection itself, so its quick
   * button lights up and the chip reads "World Z axis"; anything else (a
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
    const standard = this.keepLabel.trim().match(/^['"]([xyz])['"]$/);
    if (standard) {
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
        label: `World ${state.axis.toUpperCase()} axis`,
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
      this.slot.setPrompt('Pick an axis or edge');
    }
    for (const [axis, btn] of this.buttons) {
      const active = state?.kind === 'standard' && state.axis === axis;
      btn.classList.toggle('btn-soft', active);
      btn.classList.toggle('btn-primary', active);
    }
  }
}
