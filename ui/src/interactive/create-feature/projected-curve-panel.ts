import type { ProjectionKeep, ProjectionMode } from '../../api';
import { iconUrl } from '../../ui/icon-url';
import { DirectionSlotControl } from './direction-slot';
import { FeaturePanel } from './feature-panel';
import { OperandSlotControl } from './operand-slot';
import { ChoiceTabs } from './panel-controls';

/** The rows a pick can land in: the curves thrown, the faces they land on, the line they travel along. */
export type ProjectionRow = 'source' | 'target' | 'direction';

/** What the Direction row says while it holds nothing: the default it stands for, and what it takes. */
export const DIRECTION_HINT = 'Empty: the normal of the plane the curves lie in. Pick an axis, a straight edge, a connector, a plane or a planar face';

/**
 * The Project dialog of the Curves menu — `project(source, target)` outside
 * a sketch, curves thrown onto faces. Its rows:
 *
 * - **Curves**, a curve row taking several picks: a sketch or a curve object
 *   whole, an edge of a body as that edge ({@link OperandSlotControl});
 * - **Onto**, a surface row taking several: a surface whole, a face of a
 *   body as that face;
 * - **Mode**, *Along direction* or *Normal to surface*;
 * - **Direction**, the line the curves travel along, both ways
 *   ({@link DirectionSlotControl}), shown for *Along direction* only. Empty
 *   it is the normal of the plane the curves lie in, which its prompt says;
 * - **Keep**, *Nearest* or *All*: which images of the curves stay.
 *
 * One row is armed at a time — the primary border, where viewport and
 * timeline picks land; a click on a row arms it. The dialog opens with
 * Curves armed, the first pick there handing the border to an empty Onto;
 * the Direction row is armed only by a click on it. Switching to *Normal to
 * surface* hides the Direction row but keeps what it holds, so switching
 * back restores it; the service leaves it out of the requests. A curve puts
 * no material anywhere, so there is no operation and no scope. Pure DOM
 * state — the service owns the scene, the previews and the apply call.
 */
export class ProjectedCurvePanel extends FeaturePanel {
  /** Another row took the armed border — the service re-aims the viewer. */
  onArmedRowChange?: () => void;

  readonly source: OperandSlotControl;
  readonly target: OperandSlotControl;
  readonly direction: DirectionSlotControl;
  private readonly modeTabs: ChoiceTabs<ProjectionMode>;
  private readonly keepTabs: ChoiceTabs<ProjectionKeep>;
  private readonly directionGroup: HTMLElement;
  private armed: ProjectionRow = 'source';

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-projected-curve-panel',
      title: 'Project',
      icon: iconUrl('projected-curve'),
      bodyHtml: `
        <div data-role="source-slot"></div>
        <div data-role="target-slot"></div>
        <div class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Mode</span>
          <div data-role="mode-tabs" class="join w-full"></div>
        </div>
        <div data-role="direction-group">
          <div data-role="direction-slot"></div>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Keep</span>
          <div data-role="keep-tabs" class="join w-full"></div>
        </div>
      `,
    });
    this.source = this.operandRow('source', {
      kind: 'curve',
      label: 'Curves',
      prompt: 'Pick sketches, curves, or edges of a body',
    });
    this.target = this.operandRow('target', {
      kind: 'surface',
      label: 'Onto',
      prompt: 'Pick surfaces, or faces of a body',
    });

    this.modeTabs = new ChoiceTabs<ProjectionMode>(this.role('mode-tabs'), [
      {
        key: 'direction',
        label: 'Along direction',
        title: 'Every point of the curves travels along one line, both ways, onto the faces',
      },
      {
        key: 'normal',
        label: 'Normal to surface',
        title: "Every point of the curves goes to the closest point of the faces — .mode('normal')",
      },
    ], 'direction', { compact: true });
    this.modeTabs.onChange = () => {
      this.syncDirectionVisibility();
      // The hidden row can't stay the pick target.
      if (this.modeTabs.value === 'normal' && this.armed === 'direction') {
        this.armRow(ProjectedCurvePanel.holds(this.source) ? 'target' : 'source');
      }
      this.onChange?.();
    };

    this.directionGroup = this.role('direction-group');
    this.direction = new DirectionSlotControl(this.role('direction-slot'), {
      label: 'Direction',
      prompt: DIRECTION_HINT,
      optional: true,
    });
    this.direction.onArm = () => this.armRow('direction');
    this.direction.onChange = () => this.onChange?.();

    this.keepTabs = new ChoiceTabs<ProjectionKeep>(this.role('keep-tabs'), [
      {
        key: 'nearest',
        label: 'Nearest',
        title: 'Keep what each point of the curves meets first — the image facing them',
      },
      {
        key: 'all',
        label: 'All',
        title: "Keep every image, the far side of a closed body too — .keep('all')",
      },
    ], 'nearest');
    this.keepTabs.onChange = () => this.onChange?.();
  }

  /** How each point travels. */
  get mode(): ProjectionMode {
    return this.modeTabs.value;
  }

  /** Which images stay. */
  get keep(): ProjectionKeep {
    return this.keepTabs.value;
  }

  /** The row picks land in. */
  get armedRow(): ProjectionRow {
    return this.armed;
  }

  /** The Direction row is on show: the mode is *Along direction*. */
  get directionShown(): boolean {
    return this.modeTabs.value === 'direction';
  }

  /** The operand control of `row`. */
  slot(row: 'source' | 'target'): OperandSlotControl {
    return row === 'source' ? this.source : this.target;
  }

  /** Create mode: every row empty, the defaults chosen, Curves armed. */
  show(): void {
    this.shell.setTitle(null);
    this.source.reset();
    this.target.reset();
    this.direction.reset();
    this.modeTabs.reset();
    this.keepTabs.reset();
    this.syncDirectionVisibility();
    this.armRow('source');
    this.shell.show();
  }

  /**
   * Edit mode: the service seeds the rows with the statement's own
   * arguments and direction; the mode and what is kept open as written,
   * Curves armed, a pick there replacing (or adding to) what the statement
   * has.
   */
  showEdit(state: { mode: ProjectionMode; keep: ProjectionKeep }): void {
    this.shell.setTitle('Edit project');
    this.modeTabs.setValue(state.mode);
    this.keepTabs.setValue(state.keep);
    this.syncDirectionVisibility();
    this.armRow('source');
    this.shell.show();
  }

  /** Arm one row: it wears the primary border and takes the next pick. */
  armRow(row: ProjectionRow): void {
    const changed = this.armed !== row;
    this.armed = row;
    this.source.setArmed(row === 'source');
    this.target.setArmed(row === 'target');
    this.direction.setArmed(row === 'direction');
    if (changed) {
      this.onArmedRowChange?.();
    }
  }

  /**
   * A pick just landed in `row`: once Curves holds a pick, an empty Onto
   * takes the armed border, so the next click fills it. An Onto that holds
   * something — picks, or an edit's own argument — leaves Curves armed for
   * more; the Direction row is never armed but by a click on it.
   */
  advanceFrom(row: ProjectionRow): void {
    if (row === 'source' && ProjectedCurvePanel.holds(this.source) && ProjectedCurvePanel.isEmpty(this.target)) {
      this.armRow('target');
    }
  }

  /** Release the rows: no chips, and no consumed object kept drawn for them. */
  clearRows(): void {
    this.source.reset();
    this.target.reset();
    this.direction.reset();
  }

  /** The row holds at least one pick of its own. */
  static holds(slot: OperandSlotControl): boolean {
    const picks = slot.picks();
    return !('keep' in picks) && picks.picks.length > 0;
  }

  /** The row holds nothing: no pick, and no statement argument it keeps. */
  static isEmpty(slot: OperandSlotControl): boolean {
    const picks = slot.picks();
    return !('keep' in picks) && picks.picks.length === 0;
  }

  private syncDirectionVisibility(): void {
    this.directionGroup.classList.toggle('hidden', !this.directionShown);
  }

  private operandRow(
    row: 'source' | 'target',
    opts: { kind: 'curve' | 'surface'; label: string; prompt: string },
  ): OperandSlotControl {
    const control = new OperandSlotControl(this.role(`${row}-slot`), { ...opts, multiple: true });
    control.onArm = () => this.armRow(row);
    control.onChange = () => this.onChange?.();
    return control;
  }
}
