import { FeatureOp, OpTabs, ThinControl } from './panel-controls';
import { FeaturePanel } from './feature-panel';
import { SketchProfileOption, keepChip, sourceChip } from './sketch-profiles';
import { SketchSlotControl } from './sketch-slot';
import { PickSlot, PickSlotChip } from '../pick-slot';
import { NewVariable, ValueExpr } from '../../api';
import { collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';

/** Validated form values, or the message to show when a field is invalid. */
export type SweepValues =
  | { op: FeatureOp; thin: [ValueExpr] | [ValueExpr, ValueExpr] | null; newVariables?: NewVariable[] }
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

/**
 * The sweep dialog: operation tabs, the profile pick slot (a single sketch
 * chip) and the path pick slot — a chip container holding either one path
 * wire source (a sketch or a helix) or the picked path edges (edge picking
 * is live in the 3D view the
 * whole time the dialog is armed; picking an edge re-sources the path to
 * edges, picking a sketch re-sources it back). Timeline/wire sketch picks
 * land in whichever slot was clicked last (`armedSlot`). Pure DOM + form
 * state — the service owns scene data, edge picks, previews, and the apply
 * call.
 */
export class SweepPanel extends FeaturePanel {
  /** The path slot switched between edge picking and a sketch. */
  onPathModeChange?: () => void;
  /** The edge chip at `index` asked to be removed (the service owns picks). */
  onRemovePathChip?: (index: number) => void;
  /** An edge chip is hovered (its index) or left (null) — viewport preview. */
  onPathChipHover?: (index: number | null) => void;

  /** The slot a timeline/wire sketch pick fills — the one last clicked. */
  armedSlot: 'profile' | 'path' = 'path';

  private tabs: OpTabs;
  private thin: ThinControl;
  private profileSlot: SketchSlotControl;
  private pathSlot: PickSlot;
  private options: SketchProfileOption[] = [];
  private allowEdgePicking = false;
  private pathState: PathState = null;
  /** The edge chips the service pushed while the path is picked edges. */
  private pathEdgeChips: PickSlotChip[] = [];
  /** Edit mode: both slots start on "Current: …" chips. */
  private editMode = false;
  private keepPathLabel = '';

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-sweep-panel',
      title: 'Sweep',
      icon: '/icons/sweep.png',
      bodyHtml: `
        <div data-role="tabs" class="join w-full"></div>
        <div data-role="profile-slot"></div>
        <div data-role="path-slot"></div>
        <div data-role="thin-host" class="contents"></div>
      `,
    });

    this.tabs = new OpTabs(this.role('tabs'), [
      { op: 'add', label: 'Add', title: 'Fuse the swept solid with the model — sweep()' },
      { op: 'remove', label: 'Remove', title: 'Cut the swept solid out of the model — sweep().remove()' },
      { op: 'new', label: 'New', title: 'Keep the swept solid as a separate body — sweep().new()' },
    ]);
    this.tabs.onChange = () => this.onChange?.();
    this.thin = new ThinControl(this.role('thin-host'));
    this.thin.onChange = () => this.onChange?.();
    this.thin.onSubmit = () => this.onApply?.();

    // Boxed like the path slot below so the two pickers stand equal height.
    this.profileSlot = new SketchSlotControl(this.role('profile-slot'), { boxed: true });
    this.profileSlot.onArm = () => this.armSlot('profile');
    this.profileSlot.onChange = () => this.onChange?.();
    this.pathSlot = new PickSlot(this.role('path-slot'), { label: 'Path', multiple: true });
    this.pathSlot.onArm = () => this.armSlot('path');
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

  show(options: SketchProfileOption[], allowEdgePicking: boolean): void {
    // A fresh arming starts from defaults — the previous session's slot
    // choices would otherwise be revived by source-line matching. The
    // profile opens on the first offered sketch (the active one, in sketch
    // mode); the path on a different sketch when one exists, else on the
    // pick prompt.
    this.pathState = null;
    this.pathEdgeChips = [];
    this.editMode = false;
    this.shell.setTitle(null);
    this.options = options;
    this.allowEdgePicking = allowEdgePicking;
    this.profileSlot.reset(profileOptions(options));
    this.pathState = this.defaultPath();
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
  showEdit(state: { op: FeatureOp; thin: [ValueExpr] | [ValueExpr, ValueExpr] | null; pathLabel: string; profileLabel: string | null }): void {
    this.options = [];
    this.allowEdgePicking = true;
    this.pathState = { kind: 'keep' };
    this.pathEdgeChips = [];
    this.editMode = true;
    this.keepPathLabel = state.pathLabel;
    this.profileSlot.seedKeep(state.profileLabel);
    this.shell.setTitle('Edit sweep');
    this.tabs.setOp(state.op);
    this.thin.setValues(state.thin);
    this.renderPath();
    this.armSlot('path');
    this.shell.show();
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
    this.profileSlot.setOptions(profileOptions(options));
    if (this.pathState?.kind === 'sketch') {
      const match = matchOption(options, this.pathState.option);
      this.pathState = match ? { kind: 'sketch', option: match }
        : this.editMode ? { kind: 'keep' } : null;
    }
    this.renderPath();
  }

  selectedProfile(): SketchProfileOption | null {
    return this.profileSlot.selectedOption();
  }

  /** The profile slot's state, `keep` included (edit mode only). */
  profileSelection(): SweepProfileSelection | null {
    return this.profileSlot.selection();
  }

  pathSelection(): SweepPathSelection | null {
    return this.pathState;
  }

  /**
   * A timeline/wire sketch pick for the armed slot. Returns false when the
   * sketch isn't among the offered options.
   */
  selectSketch(slot: 'profile' | 'path', filePath: string, line: number): boolean {
    if (slot === 'profile') {
      return this.profileSlot.selectByLocation(filePath, line);
    }
    const option = this.options.find(o => o.filePath === filePath && o.line === line);
    if (!option) {
      return false;
    }
    this.pathState = { kind: 'sketch', option };
    this.pathEdgeChips = [];
    this.renderPath();
    this.onPathModeChange?.();
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

  private renderPath(): void {
    const state = this.pathState;
    if (state?.kind === 'keep') {
      this.pathSlot.setChips([keepChip(this.keepPathLabel)]);
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
    // Prefer a concrete wire source (a spine sketch or a helix) that isn't
    // the chosen profile; otherwise the prompt invites edge picks.
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

/**
 * The options the profile slot may hold: sketches only. A helix is a bare
 * wire — it can be the path, never the planar profile the sweep extrudes.
 */
function profileOptions(options: SketchProfileOption[]): SketchProfileOption[] {
  return options.filter(o => o.feature === 'sketch');
}
