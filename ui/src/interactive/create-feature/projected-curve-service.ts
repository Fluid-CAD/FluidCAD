import {
  applyProjectedCurve, applyProjectedCurveEdit,
  type FeatureSourcesResult, type GhostOperandRef, type OperandInputRef, type ProjectedCurveApplyOptions,
  type ProjectedCurveEditOptions, type ProjectedCurveGhostRequest,
} from '../../api';
import { hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { SceneObjectRender } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { Viewer } from '../../viewer';
import type { ConnectorPickDetail, ParsedFeatureOf } from '../feature-dialog-registry';
import { DirectionRow } from './direction-row';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { OperandRowService, type OperandRowHooks, type RowEdits, type RowLists } from './operand-row-service';
import { ProjectedCurvePanel, type ProjectionRow } from './projected-curve-panel';

/** The parsed statement the dialog edits. */
type ParsedProjectedCurve = ParsedFeatureOf<'projected-curve'>;

/** What the Project dialog reads and sends, each with its curve and surface rows. */
type ProjectionWires = {
  parsed: ParsedProjectedCurve;
  sources: Extract<FeatureSourcesResult, { feature: 'projected-curve' }>;
  create: ProjectedCurveApplyOptions;
  edit: ProjectedCurveEditOptions;
  ghost: ProjectedCurveGhostRequest;
};

/**
 * The Project dialog, opened from the Curves menu: `project(source,
 * target)` outside a sketch, curves thrown onto faces. Its rows
 * ({@link ProjectedCurvePanel}) collect the curves (sketches and curve
 * objects whole, edges of bodies), the faces they land on (surfaces whole,
 * faces of bodies) and the line they travel along — a world axis, an
 * `axis()`, a straight edge, a connector, or a plane, an origin plane or a
 * planar face standing for its normal; empty it is the normal of the plane
 * the curves lie in. The mode and what is kept are two button rows. A
 * double-click grows the armed operand row by an edge's chain or loop or a
 * face's bucket, and the right-click menu's groups land in it as plain
 * picks. Once both operand rows hold a pick the curve previews, in the
 * colour of an applied curve, and an engine refusal (the projection misses
 * the faces, curves that lie in no plane with no direction) shows in the
 * dialog. Apply writes the statement; the re-render is the result, editor
 * undo the rollback.
 *
 * *Normal to surface* hides the Direction row and leaves its pick out of
 * every request, where the row keeps it for a switch back.
 *
 * A timeline double-click reopens it over an existing statement: the view
 * rolls back to just before it, the rows open on the statement's own
 * arguments as "Current: …" chips and its own direction, the mode and Keep
 * as written, and Apply sends only what changed — a row, the mode, Keep,
 * a direction re-picked or removed. The operand rows, the gestures, editing
 * and the preview are the operand-row dialogs' ({@link OperandRowService});
 * the Direction row is a {@link DirectionRow} beside them.
 */
export class ProjectedCurveFeatureService extends OperandRowService<ProjectionRow, 'direction', ProjectionWires, ProjectedCurvePanel> {
  private readonly direction: DirectionRow;

  constructor(
    container: HTMLElement,
    viewer: Viewer,
    _navbar: Navbar,
    launcher: FeatureLauncher = detachedLauncher(),
    hooks: OperandRowHooks = {},
  ) {
    const panel = new ProjectedCurvePanel(container);
    const direction = new DirectionRow(panel.direction, container, viewer, () => panel.directionShown);
    super(container, viewer, launcher, hooks, panel, {
      kind: 'projected-curve',
      noun: 'projected curve',
      create: applyProjectedCurve,
      edit: applyProjectedCurveEdit,
      extraRows: { direction },
    });
    this.direction = direction;
  }

  /** The Direction row is armed: axis lines, plane quads and connector gizmos are its picks. */
  get isDirectionPicking(): boolean {
    return this.isActive && this.panel.armedRow === 'direction';
  }

  /** A `plane()` quad clicked while Direction is armed: its normal. */
  handlePlanePick(shapeId: string): void {
    if (this.isDirectionPicking) {
      this.direction.pickPlaneQuad(shapeId);
    }
  }

  /**
   * A connector gizmo clicked while Direction is armed: the connector's Z
   * axis through its origin. Several gizmos under the cursor ask which first.
   */
  handleConnectorPick(connectorId: string | null, detail?: ConnectorPickDetail): void {
    if (this.isDirectionPicking && connectorId) {
      this.direction.pickConnector(connectorId, detail);
    }
  }

  /**
   * Curves go onto a body — a solid or a surface — and a body's edges are
   * curves to throw themselves, so a body is all it needs.
   */
  protected isAvailable(sceneObjects: SceneObjectRender[]): boolean {
    return hasSolid(sceneObjects) || hasSurface(sceneObjects);
  }

  /** The rows, the mode, the direction — null when the row is empty or hidden by *Normal to surface* — and what is kept. */
  protected createRequest(rows: RowLists<ProjectionRow, OperandInputRef>): ProjectedCurveApplyOptions {
    return { ...rows, mode: this.panel.mode, direction: this.direction.createValue(), keep: this.panel.keep };
  }

  /**
   * Only what changed: the re-picked rows; the mode and Keep when they
   * differ from the statement's; the direction left out while the row keeps
   * the statement's own, `cleared` when the row was emptied — or hidden by
   * *Normal to surface*, since the engine refuses a direction with mode
   * `'normal'` — over a statement that has one, else the new one.
   */
  protected editRequest(rows: RowEdits<ProjectionRow>, parsed: ParsedProjectedCurve): ProjectedCurveEditOptions {
    const direction = this.direction.editValue(parsed.directionText);
    return {
      ...rows,
      mode: this.panel.mode !== parsed.mode ? this.panel.mode : undefined,
      direction,
      keep: this.panel.keep !== parsed.keep ? this.panel.keep : undefined,
      ...this.editSession(rows, DirectionRow.picksEntity(direction)),
    };
  }

  /** The rows with the mode, Keep and the direction, once a kept direction resolves to something the preview reads. */
  protected ghostRequest(rows: RowLists<ProjectionRow, GhostOperandRef>): ProjectedCurveGhostRequest | null {
    const direction = this.direction.ghost();
    if (direction === undefined) {
      return null;
    }
    return { feature: 'projected-curve', ...rows, mode: this.panel.mode, direction, keep: this.panel.keep };
  }

  /** The mode and Keep as written, and the Direction row on the statement's own direction — a world axis or origin plane literal as that axis or plane. */
  protected override seedEdit(parsed: ParsedProjectedCurve): void {
    this.panel.seedOptions({ mode: parsed.mode, keep: parsed.keep });
    this.direction.seedKeep(parsed.directionText);
  }

  /** What the statement's own direction resolves to, which its chip lights and the preview reads. */
  protected override seedSources(sources: ProjectionWires['sources'] | null): void {
    this.direction.setKeptSource(sources?.direction ?? null);
  }
}
