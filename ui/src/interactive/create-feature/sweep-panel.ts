import { FeatureOp, OpTabs, PanelShell, ThinControl } from './panel-controls';
import { SketchProfileOption, keepSketchChip, sourceChip } from './sketch-profiles';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type SweepValues =
  | { op: FeatureOp; thin: [ValueExpr] | null; newVariables?: NewVariable[] }
  | { error: string };

export type SweepPathSelection =
  | { kind: 'edges' }
  | { kind: 'sketch'; option: SketchProfileOption }
  /** Edit mode only: the statement's own path expression stays. */
  | { kind: 'keep' };

export type SweepProfileSelection =
  | { kind: 'sketch'; option: SketchProfileOption }
  /** Edit mode only: the statement's own profile expression stays. */
  | { kind: 'keep' };

/** The path slot's internal state; `null` is the empty pick prompt. */
type PathState =
  | { kind: 'keep' }
  | { kind: 'sketch'; option: SketchProfileOption }
  | { kind: 'edges' }
  | null;

type ProfileState =
  | { kind: 'keep' }
  | { kind: 'sketch'; option: SketchProfileOption }
  | null;

/**
 * The sweep dialog: operation tabs, the profile pick slot (a single sketch
 * chip) and the path pick slot — a chip container holding either one path
 * sketch or the picked path edges (edge picking is live in the 3D view the
 * whole time the dialog is armed; picking an edge re-sources the path to
 * edges, picking a sketch re-sources it back). Timeline/wire sketch picks
 * land in whichever slot was clicked last (`armedSlot`). Pure DOM + form
 * state — the service owns scene data, edge picks, previews, and the apply
 * call.
 */
export class SweepPanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** The path slot switched between edge picking and a sketch. */
  onPathModeChange?: () => void;
  /** The edge chip at `index` asked to be removed (the service owns picks). */
  onRemovePathChip?: (index: number) => void;
  /** An edge chip is hovered (its index) or left (null) — viewport preview. */
  onPathChipHover?: (index: number | null) => void;

  /** The slot a timeline/wire sketch pick fills — the one last clicked. */
  armedSlot: 'profile' | 'path' = 'path';

  private shell: PanelShell;
  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: PickSlot;
  private pathSlot: PickSlot;
  private applyBtn: HTMLButtonElement;
  private options: SketchProfileOption[] = [];
  private allowEdgePicking = false;
  private profileState: ProfileState = null;
  private pathState: PathState = null;
  /** The edge chips the service pushed while the path is picked edges. */
  private pathEdgeChips: PickSlotChip[] = [];
  /** Edit mode: both slots start on "Current: …" chips. */
  private editMode = false;
  private keepPathLabel = '';
  /** The kept profile's expression text; null when the statement is implicit. */
  private keepProfileLabel: string | null = null;

  constructor(container: HTMLElement) {
    this.shell = new PanelShell(container, 'fluidcad-sweep-panel', 'Sweep', '/icons/sweep.png');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div data-role="tabs" class="join w-full"></div>
      <div data-role="profile-slot"></div>
      <div data-role="path-slot"></div>
      <div data-role="thin-host" class="contents"></div>
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
      </div>
    `);

    this.tabs = new OpTabs(this.shell.body.querySelector('[data-role="tabs"]')!, [
      { op: 'add', label: 'Add', title: 'Fuse the swept solid with the model — sweep()' },
      { op: 'remove', label: 'Remove', title: 'Cut the swept solid out of the model — sweep().remove()' },
      { op: 'new', label: 'New', title: 'Keep the swept solid as a separate body — sweep().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.shell.body.querySelector('[data-role="thin-host"]')!);
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    this.profileSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="profile-slot"]')!,
      // Boxed like the path slot below so the two pickers stand equal height.
      { label: 'Sketch', multiple: false, boxed: true },
    );
    this.pathSlot = new PickSlot(
      this.shell.body.querySelector('[data-role="path-slot"]')!,
      { label: 'Path', multiple: true },
    );
    this.applyBtn = this.shell.body.querySelector('[data-role="apply"]')!;

    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.shell.body.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.onExit?.());
    this.profileSlot.onArm = () => this.armSlot('profile');
    this.pathSlot.onArm = () => this.armSlot('path');
    this.profileSlot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own profile (a re-pick is undone, never the profile itself).
      this.profileState = this.editMode ? { kind: 'keep' } : null;
      this.renderProfile();
      this.onChange?.();
    };
    this.pathSlot.onRemove = (index) => {
      if (this.pathState?.kind === 'edges') {
        this.onRemovePathChip?.(index);
        return;
      }
      if (this.pathState?.kind === 'sketch') {
        this.pathState = this.editMode ? { kind: 'keep' } : null;
        this.renderPath();
        this.onPathModeChange?.();
        this.onChange?.();
      }
    };
    this.pathSlot.onChipHover = (index) => {
      if (this.pathState?.kind === 'edges') {
        this.onPathChipHover?.(index);
      }
    };
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  show(options: SketchProfileOption[], allowEdgePicking: boolean): void {
    // A fresh arming starts from defaults — the previous session's slot
    // choices would otherwise be revived by source-line matching. The
    // profile opens on the first offered sketch (the active one, in sketch
    // mode); the path on a different sketch when one exists, else on the
    // pick prompt.
    this.profileState = null;
    this.pathState = null;
    this.pathEdgeChips = [];
    this.editMode = false;
    this.shell.setTitle(null);
    this.setOptions(options, allowEdgePicking);
    if (this.profileState === null && options.length > 0) {
      this.profileState = { kind: 'sketch', option: options[0] };
    }
    if (this.pathState === null) {
      this.pathState = this.defaultPath();
    }
    this.renderProfile();
    this.renderPath();
    this.armSlot('path');
    this.shell.show();
  }

  /**
   * Open prefilled from an existing statement (edit mode). Both slots start
   * on a "Current: …" chip that keeps the statement's own expression
   * verbatim; picking another sketch (or edges, for the path) re-sources
   * that slot, and its ✕ reverts to the kept expression. The op tabs and
   * thin control edit in place.
   */
  showEdit(state: { op: FeatureOp; thin: [ValueExpr] | null; pathLabel: string; profileLabel: string | null }): void {
    this.options = [];
    this.allowEdgePicking = true;
    this.profileState = { kind: 'keep' };
    this.pathState = { kind: 'keep' };
    this.pathEdgeChips = [];
    this.editMode = true;
    this.keepPathLabel = state.pathLabel;
    this.keepProfileLabel = state.profileLabel;
    this.shell.setTitle('Edit sweep');
    this.tabs.setOp(state.op);
    this.thin.setValues(state.thin);
    this.renderProfile();
    this.renderPath();
    this.armSlot('path');
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  /**
   * Refresh the offered sketches after a re-render, keeping current choices
   * when the same sketch is still offered (matched by kind + source
   * location). A choice that vanished falls back to the "Current: …" chip
   * in edit mode, or to the pick prompt.
   */
  setOptions(options: SketchProfileOption[], allowEdgePicking: boolean): void {
    this.options = options;
    this.allowEdgePicking = allowEdgePicking;
    if (this.profileState?.kind === 'sketch') {
      const match = matchOption(options, this.profileState.option);
      this.profileState = match ? { kind: 'sketch', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    if (this.pathState?.kind === 'sketch') {
      const match = matchOption(options, this.pathState.option);
      this.pathState = match ? { kind: 'sketch', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    this.renderProfile();
    this.renderPath();
  }

  selectedProfile(): SketchProfileOption | null {
    const selection = this.profileSelection();
    return selection?.kind === 'sketch' ? selection.option : null;
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): SweepProfileSelection | null {
    return this.profileState;
  }

  pathSelection(): SweepPathSelection | null {
    return this.pathState;
  }

  /**
   * A timeline/wire sketch pick for the armed slot. Returns false when the
   * sketch isn't among the offered options.
   */
  selectSketch(slot: 'profile' | 'path', filePath: string, line: number): boolean {
    const option = this.options.find(o => o.filePath === filePath && o.line === line);
    if (!option) {
      return false;
    }
    if (slot === 'profile') {
      this.profileState = { kind: 'sketch', option };
      this.renderProfile();
    } else {
      this.pathState = { kind: 'sketch', option };
      this.pathEdgeChips = [];
      this.renderPath();
      this.onPathModeChange?.();
    }
    return true;
  }

  /**
   * The picked path edges as chips (the service owns the pick set). Any
   * chips re-source the path to edges; an empty set while the path is
   * already edges keeps the mode and prompts for picks.
   */
  setPathEdgeChips(chips: PickSlotChip[]): void {
    this.pathEdgeChips = chips;
    if (chips.length > 0) {
      this.pathState = { kind: 'edges' };
    }
    this.renderPath();
  }

  /** Reset the path to the statement's own expression (edit) or the prompt. */
  setPathKeep(): void {
    this.pathState = this.editMode ? { kind: 'keep' } : null;
    this.pathEdgeChips = [];
    this.renderPath();
  }

  values(): SweepValues {
    const thin = this.thin.values();
    if ('error' in thin) {
      return thin;
    }
    return { op: this.tabs.op, thin: thin.thin, newVariables: collectNewVariables([thin]) };
  }

  /** The variables the thin thickness field's dropdown offers. */
  setScopeVariables(variables: VariableInfo[]): void {
    this.thin.setVariables(variables);
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

  private renderProfile(): void {
    const state = this.profileState;
    if (state?.kind === 'keep') {
      this.profileSlot.setChips([keepSketchChip(this.keepProfileLabel)]);
      this.profileSlot.setPrompt(null);
    } else {
      this.profileSlot.setChips(state?.kind === 'sketch'
        ? [sourceChip(state.option, { badge: '●', removable: true })]
        : []);
      this.profileSlot.setPrompt(state
        ? null
        : this.options.length > 0 || this.editMode
          ? 'Pick a sketch'
          : 'No sketch — create one first');
    }
  }

  private renderPath(): void {
    const state = this.pathState;
    if (state?.kind === 'keep') {
      this.pathSlot.setChips([{
        label: `Current: ${this.keepPathLabel}`,
        badge: '●',
        removable: false,
      }]);
      this.pathSlot.setPrompt(null);
    } else if (state?.kind === 'sketch') {
      this.pathSlot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.pathSlot.setPrompt(null);
    } else if (state?.kind === 'edges') {
      this.pathSlot.setChips(this.pathEdgeChips);
      this.pathSlot.setPrompt(this.pathEdgeChips.length > 0 ? null : 'Pick edges');
    } else {
      this.pathSlot.setChips([]);
      this.pathSlot.setPrompt(this.allowEdgePicking
        ? 'Pick edges or a sketch'
        : 'Pick a sketch');
    }
  }

  private defaultPath(): PathState {
    // Prefer a concrete sketch (the common sweep spine idiom) that isn't the
    // chosen profile; otherwise the prompt invites edge picks.
    const profile = this.selectedProfile();
    const other = this.options.find(o =>
      !profile || o.filePath !== profile.filePath || o.line !== profile.line);
    return other ? { kind: 'sketch', option: other } : null;
  }

  private armSlot(slot: 'profile' | 'path'): void {
    this.armedSlot = slot;
    this.profileSlot.setArmed(slot === 'profile');
    this.pathSlot.setArmed(slot === 'path');
  }
}

/** The offered option matching `previous` by kind + source location. */
function matchOption(
  options: SketchProfileOption[],
  previous: SketchProfileOption,
): SketchProfileOption | undefined {
  return options.find(o => o.kind === previous.kind
    && (o.kind === 'active' || (o.filePath === previous.filePath && o.line === previous.line)));
}
