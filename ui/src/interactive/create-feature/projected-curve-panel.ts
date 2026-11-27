import type { ProjectionKeep, ProjectionMode } from '../../api';
import { DirectionSlotControl } from './direction-slot';
import { OperandRowPanel } from './operand-row-panel';
import { ChoiceTabs } from './panel-controls';

/** The operand rows: the curves thrown, and the faces they land on. */
export type ProjectionRow = 'source' | 'target';

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
 * The dialog opens with Curves armed, the first pick there handing the
 * border to an empty Onto ({@link OperandRowPanel}); the Direction row is
 * armed only by a click on it. Switching to *Normal to surface* hides the
 * Direction row but keeps what it holds, so switching back restores it;
 * the service leaves it out of the requests. A curve puts no material
 * anywhere, so there is no operation and no scope.
 */
export class ProjectedCurvePanel extends OperandRowPanel<ProjectionRow, 'direction'> {
  readonly direction: DirectionSlotControl;
  private readonly modeTabs: ChoiceTabs<ProjectionMode>;
  private readonly keepTabs: ChoiceTabs<ProjectionKeep>;
  private readonly directionGroup: HTMLElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'projected-curve',
      title: 'Project',
      editTitle: 'Edit project',
      // Room for the mode's two labels on one line each.
      width: 'wider',
      rows: [
        {
          row: 'source',
          kind: 'curve',
          label: 'Curves',
          prompt: 'Pick sketches, curves, or edges of a body',
          empty: 'Pick the curves to project: sketches, curves, or edges of a body.',
        },
        {
          row: 'target',
          kind: 'surface',
          label: 'Onto',
          prompt: 'Pick surfaces, or faces of a body',
          empty: 'Pick the faces to project onto: surfaces, or faces of a body.',
        },
      ],
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
      if (this.modeTabs.value === 'normal' && this.armedRow === 'direction') {
        this.armRow(OperandRowPanel.holds(this.slot('source')) ? 'target' : 'source');
      }
      this.onChange?.();
    };

    this.directionGroup = this.role('direction-group');
    this.direction = this.armable('direction', new DirectionSlotControl(this.role('direction-slot'), {
      label: 'Direction',
      prompt: DIRECTION_HINT,
      optional: true,
    }));

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

  /** The Direction row is on show: the mode is *Along direction*. */
  get directionShown(): boolean {
    return this.modeTabs.value === 'direction';
  }

  /** Edit mode: the mode and what is kept, as the statement writes them. */
  seedOptions(state: { mode: ProjectionMode; keep: ProjectionKeep }): void {
    this.modeTabs.setValue(state.mode);
    this.keepTabs.setValue(state.keep);
    this.syncDirectionVisibility();
  }

  /** Create mode: the defaults chosen. */
  protected override resetOptions(): void {
    this.modeTabs.reset();
    this.keepTabs.reset();
    this.syncDirectionVisibility();
  }

  private syncDirectionVisibility(): void {
    this.directionGroup.classList.toggle('hidden', !this.directionShown);
  }
}
