import { OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption, sourceChip } from './sketch-profiles';
import { AxisOption } from './axis-options';
import { PickSlot } from '../pick-slot';
import { RevolveOptionValues } from '../../api';

/** Validated form values, or the message to show when a field is invalid. */
export type RevolveValues = RevolveOptionValues | { error: string };

/**
 * The axis slot's state: a standard world axis (the X/Y/Z quick buttons), an
 * existing axis statement, a picked edge (the service owns the entity), or —
 * edit mode only — the statement's own axis expression kept verbatim.
 */
export type RevolveAxisSelection =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'keep' };

const STANDARD_AXES = ['x', 'y', 'z'] as const;

/**
 * The revolve dialog: an Add / Remove / New tab row (the boolean operation),
 * the profile pick slot (a single chip — filled by clicking a sketch in the
 * timeline or its wires in 3D), the axis pick slot (a single chip — an axis
 * or edge picked in 3D, or one of the X/Y/Z quick buttons under it), the
 * sweep angle in degrees, and a thin() toggle with its thickness. Exactly
 * one slot is ARMED at a time — clicked to activate, marked by the primary
 * border — and 3D picks land only there (the sweep/loft idiom); timeline
 * rows are typed and always route, re-arming their slot. Pure DOM + form
 * state — the service owns scene data, the picked edge entity, previews,
 * and the apply call.
 */
export class RevolvePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The axis slot left edge mode (✕, a standard/axis pick) — drop the entity. */
  onAxisModeChange?: () => void;
  /** The armed slot changed — the service re-aims the viewer pick channels. */
  onArmedSlotChange?: () => void;

  /** The slot 3D picks land in — the one last clicked. */
  armedSlot: 'profile' | 'axis' = 'axis';

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: PickSlot;
  private axisSlot: PickSlot;
  private axisButtons = new Map<'x' | 'y' | 'z', HTMLButtonElement>();
  private angleInput: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  private profileOptions: SketchProfileOption[] = [];
  /** The profile slot's state: an option index, the keep entry, or empty. */
  private profileState: number | 'keep' | null = null;
  private axisState: RevolveAxisSelection | null = null;
  /** Edit mode: the slots start on "Current: …" chips. */
  private editMode = false;
  private keepProfileLabel = '';
  private keepAxisLabel = '';

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-revolve-panel', 'Revolve mode', '/icons/revolve.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <div data-role="profile-slot"></div>
      <div class="flex flex-col gap-1.5">
        <div data-role="axis-slot"></div>
        <div data-role="axis-buttons" class="join w-full"></div>
      </div>
      <label class="flex flex-col gap-1.5" title="Sweep angle in degrees — 360 is a full revolution">
        <span class="text-base-content/70">Angle (°)</span>
        <input data-role="angle" type="number" step="5" value="360"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the revolved solid with the model — revolve()' },
      { op: 'remove', label: 'Remove', title: 'Cut the revolved solid out of the model — revolve().remove()' },
      { op: 'new', label: 'New', title: 'Keep the revolved solid as a separate body — revolve().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="profile-slot"]')!,
      { label: 'Sketch', multiple: false },
    );
    this.profileSlot.onArm = () => this.armSlot('profile');
    this.profileSlot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own profile (a re-pick is undone, never the profile itself).
      this.profileState = this.editMode ? 'keep' : null;
      this.renderProfile();
      this.onChange?.();
    };

    this.axisSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="axis-slot"]')!,
      { label: 'Axis', multiple: false },
    );
    this.axisSlot.onArm = () => this.armSlot('axis');
    this.axisSlot.onRemove = () => {
      this.axisState = this.editMode ? { kind: 'keep' } : null;
      this.renderAxis();
      this.onAxisModeChange?.();
      this.onChange?.();
    };

    // The world-axis quick row: one click sets the slot without a 3D pick.
    const buttonsHost = this.shell.body.querySelector('[data-role="axis-buttons"]')!;
    for (const axis of STANDARD_AXES) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm join-item flex-1 font-normal';
      btn.textContent = axis.toUpperCase();
      btn.title = `Revolve around the world ${axis.toUpperCase()} axis`;
      btn.addEventListener('click', () => {
        this.axisState = { kind: 'standard', axis };
        this.armSlot('axis');
        this.renderAxis();
        this.onAxisModeChange?.();
        this.onChange?.();
      });
      buttonsHost.appendChild(btn);
      this.axisButtons.set(axis, btn);
    }

    this.angleInput = this.shell.body.querySelector('[data-role="angle"]')!;
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.angleInput.addEventListener('input', () => this.onChange?.());
    this.angleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onApply?.();
      }
      e.stopPropagation();
    });
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(profiles: SketchProfileOption[], axes: AxisOption[]): void {
    // A fresh arming starts from defaults — the previous session's choices
    // would otherwise be revived by source-line matching. The profile opens
    // on the first offered sketch (the active one, in sketch mode); the axis
    // on the pick prompt — an axis is an explicit choice.
    this.profileOptions = [];
    this.profileState = null;
    this.axisState = null;
    this.editMode = false;
    this.shell.setTitle(null);
    this.angleInput.value = '360';
    this.setOptions(profiles, axes);
    if (this.profileState === null && profiles.length > 0) {
      this.profileState = 0;
      this.renderProfile();
    }
    // The profile pre-fills; the axis is the explicit next step.
    this.armSlot('axis');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). Both slots start
   * on a "Current: …" chip that keeps the statement's own expression
   * verbatim; picking another sketch (or an axis/edge/standard axis) re-
   * sources that slot, and its ✕ reverts to the kept expression. The op
   * tabs, angle and thin controls edit in place.
   */
  showEdit(state: RevolveOptionValues & {
    thin: [number] | null;
    axisLabel: string;
    profileLabel: string;
  }): void {
    this.profileOptions = [];
    this.profileState = 'keep';
    this.axisState = { kind: 'keep' };
    this.editMode = true;
    this.keepProfileLabel = state.profileLabel;
    this.keepAxisLabel = state.axisLabel;
    this.shell.setTitle('Edit revolve');
    this.tabs.setOp(state.op);
    this.angleInput.value = String(state.angle);
    this.thin.setValues(state.thin);
    this.renderProfile();
    this.renderAxis();
    this.armSlot('axis');
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the offered sketches/axes after a re-render, keeping current
   * choices when the same statement is still offered (matched by kind +
   * source location — scene ids change every render). A choice that
   * vanished falls back to the "Current: …" chip in edit mode, or to the
   * pick prompt. Standard-axis and picked-edge states are scene-independent
   * and survive as they are (the service re-validates edge picks itself).
   */
  setOptions(profiles: SketchProfileOption[], axes: AxisOption[]): void {
    const previousProfile = this.profileSelection();
    this.profileOptions = profiles;
    if (previousProfile?.kind === 'sketch') {
      const prev = previousProfile.option;
      const match = profiles.findIndex(o => o.kind === prev.kind
        && (o.kind === 'active' || (o.filePath === prev.filePath && o.line === prev.line)));
      this.profileState = match >= 0 ? match : this.editMode ? 'keep' : null;
    } else if (previousProfile?.kind === 'keep') {
      this.profileState = 'keep';
    } else {
      this.profileState = null;
    }
    if (this.axisState?.kind === 'axis') {
      const prev = this.axisState.option;
      const match = axes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.axisState = match
        ? { kind: 'axis', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    this.renderProfile();
    this.renderAxis();
  }

  selectedProfile(): SketchProfileOption | null {
    const selection = this.profileSelection();
    return selection?.kind === 'sketch' ? selection.option : null;
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): { kind: 'keep' } | { kind: 'sketch'; option: SketchProfileOption } | null {
    if (this.profileState === 'keep') {
      return this.editMode ? { kind: 'keep' } : null;
    }
    const option = this.profileState !== null ? this.profileOptions[this.profileState] : undefined;
    return option ? { kind: 'sketch', option } : null;
  }

  axisSelection(): RevolveAxisSelection | null {
    return this.axisState;
  }

  /**
   * Programmatic profile choice (a timeline pick); arms the profile slot so
   * the border tracks where the pick landed. No change event fires.
   */
  selectProfile(index: number): void {
    if (this.profileOptions[index]) {
      this.profileState = index;
      this.armSlot('profile');
      this.renderProfile();
    }
  }

  /**
   * An axis picked in 3D or the timeline; arms the axis slot so the border
   * tracks where the pick landed. No change event fires.
   */
  selectAxis(option: AxisOption): void {
    this.axisState = { kind: 'axis', option };
    this.armSlot('axis');
    this.renderAxis();
  }

  /**
   * The axis slot's picked-edge chip (the service owns the entity); null
   * clears it — back to the statement's own axis (edit mode), else the
   * prompt.
   */
  setAxisEdgeChip(label: string | null): void {
    if (label !== null) {
      this.axisState = { kind: 'edge' };
    } else if (this.axisState?.kind === 'edge') {
      this.axisState = this.editMode ? { kind: 'keep' } : null;
    }
    this.renderAxis(label ?? undefined);
  }

  values(): RevolveValues {
    const angle = parseFloat(this.angleInput.value);
    if (!Number.isFinite(angle) || angle === 0) {
      return { error: 'Enter a nonzero sweep angle in degrees.' };
    }
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return { op: this.tabs.op, angle, thin: thin.thin };
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

  /** The profile slot: one chip (the chosen sketch), or the pick prompt. */
  private renderProfile(): void {
    if (this.profileState === 'keep') {
      this.profileSlot.setChips([{
        label: `Last Sketch: ${this.keepProfileLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.profileSlot.setPrompt(null);
    } else {
      const option = this.profileState !== null ? this.profileOptions[this.profileState] : undefined;
      this.profileSlot.setChips(option
        ? [sourceChip(option, { badge: '●', removable: true })]
        : []);
      this.profileSlot.setPrompt(option
        ? null
        : this.profileOptions.length > 0 || this.editMode
          ? 'Pick a sketch'
          : 'No sketch — create one first');
    }
  }

  /** The axis slot: one chip (the chosen axis), or the pick prompt. */
  private renderAxis(edgeLabel?: string): void {
    const state = this.axisState;
    if (state?.kind === 'keep') {
      this.axisSlot.setChips([{
        label: `Current: ${this.keepAxisLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.axisSlot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.axisSlot.setChips([{
        label: `World ${state.axis.toUpperCase()} axis`,
        badge: '●',
        removable: true,
      }]);
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
      btn.classList.toggle('btn-soft', state?.kind === 'standard' && state.axis === axis);
      btn.classList.toggle('btn-primary', state?.kind === 'standard' && state.axis === axis);
    }
  }

  /**
   * Arm one slot: it takes the 3D picks and wears the primary border; the
   * other goes quiet. The service re-aims the viewer pick channels on every
   * actual change.
   */
  private armSlot(slot: 'profile' | 'axis'): void {
    const changed = this.armedSlot !== slot;
    this.armedSlot = slot;
    this.profileSlot.setArmed(slot === 'profile');
    this.axisSlot.setArmed(slot === 'axis');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }
}
