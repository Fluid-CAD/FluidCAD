import type { DirectionRef, GhostDirectionRef, SourceSlotRef } from '../../api';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { Viewer } from '../../viewer';
import type { ConnectorPickDetail } from '../feature-dialog-registry';
import { ConnectorPicks } from './connector-picks';
import type { DirectionSlotControl } from './direction-slot';
import type { ExtraPickRow, ExtraRowHighlight } from './extra-pick-row';
import type { PickChannels, PickOutcome, StandardDatum } from './schema/schema-pickers';

/** An edit's direction: left out (kept as written), cleared, or the new one. */
export type DirectionEdit = DirectionRef | { kind: 'cleared' } | undefined;

/**
 * The Direction row of an operand-row dialog, opted into beside its operand
 * rows (Project's; ruled's Direction type next): the panel's
 * {@link DirectionSlotControl}, with what the service does for it. While it
 * is armed it shows the world axes and the origin planes, a click on one
 * landing in the row, and it takes the `plane()` quads and connector gizmos
 * the service hands it ({@link pickPlaneQuad}, {@link pickConnector} —
 * asking which connector when several gizmos sit under the cursor).
 *
 * An option can hide the row (`shown`): hidden, it lights nothing and the
 * requests leave its direction out, while the control keeps it for when
 * the row shows again. It answers the direction as each request carries
 * it: {@link createValue}, {@link editValue}, {@link ghost}.
 */
export class DirectionRow implements ExtraPickRow {
  onPick?: (outcome: PickOutcome) => void;
  readonly rowRefusal = 'gives no direction — pick an axis, a plane or a connector row, or an edge or a face in the viewport.';

  private readonly connectors: ConnectorPicks;
  /** The row holds the armed border: the world axes and origin planes it showed are its picks. */
  private aimed = false;

  constructor(
    private readonly control: DirectionSlotControl,
    container: HTMLElement,
    private readonly viewer: Viewer,
    /** Whether the row is on show (Project hides it for *Normal to surface*). */
    private readonly isShown: () => boolean = () => true,
  ) {
    this.connectors = new ConnectorPicks(container, viewer);
  }

  get shown(): boolean {
    return this.isShown();
  }

  channels(): PickChannels {
    return this.control.channels();
  }

  aim(armed: boolean): void {
    this.aimed = armed;
    if (armed) {
      this.viewer.showStandardAxes(this.onStandardPick);
      this.viewer.showStandardPlanes(this.onStandardPick);
    } else {
      this.viewer.hideStandardAxes();
      this.viewer.hideStandardPlanes();
    }
  }

  /** An edge or a face, an `axis()` line or a `plane()` quad: a straight edge or a planar face, the engine asked which it is. */
  takeClick(shapeId: string, sub: NonNullable<SubSelection>): Promise<PickOutcome> {
    return this.control.takeClick(shapeId, sub);
  }

  /** An `axis()`, a `plane()` or a connector row. */
  takeRow(row: SceneObjectRender): PickOutcome {
    return this.control.takeRow(row);
  }

  /** The connectors re-collect with every render; a picked edge or face dies with one that re-mints ids. */
  setScene(sceneObjects: SceneObjectRender[], opts: { dropEntities: boolean }): boolean {
    this.connectors.collect(sceneObjects);
    return opts.dropEntities ? this.control.setScene(sceneObjects) : false;
  }

  /** The chosen world axis and connector draw marked while the row shows; the rest joins the dialog's highlight. */
  paint(): ExtraRowHighlight {
    const lit = this.shown ? this.control.highlight() : null;
    this.viewer.setSelectedStandardAxes(lit?.standardAxes ?? []);
    this.viewer.setPickedConnectors(lit?.connectorIds ?? []);
    return { entities: lit?.entities ?? [], wireIds: lit?.wireIds ?? [], planeQuadIds: lit?.planeQuadIds ?? [] };
  }

  close(): void {
    this.connectors.close();
  }

  release(): void {
    this.aimed = false;
    this.viewer.pickPlanes = false;
    this.viewer.setConnectorPicking(false);
    this.viewer.setPickedConnectors([]);
    this.viewer.setSelectedStandardAxes([]);
    this.viewer.hideStandardAxes();
    this.viewer.hideStandardPlanes();
  }

  /** A `plane()` quad clicked while the row is armed: its normal. */
  pickPlaneQuad(shapeId: string): void {
    this.onPick?.(this.control.takePlaneQuad(shapeId));
  }

  /**
   * A connector gizmo clicked while the row is armed: the connector's Z axis
   * through its origin. Several gizmos under the cursor ask which first.
   */
  pickConnector(connectorId: string, detail: ConnectorPickDetail | undefined): void {
    const refusal = this.connectors.pick(connectorId, detail,
      option => this.onPick?.(this.control.takeConnector(option.id)));
    if (refusal) {
      this.onPick?.({ message: refusal });
    }
  }

  /** Edit mode: the statement's own direction (`null` when it has none). */
  seedKeep(text: string | null): void {
    this.control.seedKeep(text);
  }

  /** What the engine resolved the statement's own direction to. */
  setKeptSource(source: SourceSlotRef | null): void {
    this.control.setKeptSource(source);
  }

  /** The create request's direction: null when the row is empty, keeps nothing new, or is hidden. */
  createValue(): DirectionRef | null {
    const held = this.shown ? this.control.value() : null;
    return held && !('keep' in held) ? held : null;
  }

  /**
   * An edit's direction, against the statement's own (`written`): left out
   * while the row keeps it (a world-axis or origin-plane literal read back
   * as its axis or plane among them), `cleared` when the row was emptied or
   * hidden over a statement that has one, or the new one.
   */
  editValue(written: string | null): DirectionEdit {
    const held = this.shown ? this.control.value() : null;
    if (held === null) {
      return written !== null ? { kind: 'cleared' } : undefined;
    }
    if ('keep' in held || DirectionRow.writtenAs(held, written)) {
      return undefined;
    }
    return held;
  }

  /**
   * The direction on the preview wire: null for none (an empty or hidden
   * row), the row's pick, or a kept one as the engine resolved it;
   * undefined while a kept direction stands for nothing the preview can
   * read (an expression, or the answer still in flight).
   */
  ghost(): GhostDirectionRef | null | undefined {
    if (!this.shown || this.control.value() === null) {
      return null;
    }
    return this.control.ghost() ?? undefined;
  }

  /** An edit's direction names an edge or a face, which needs the session boundary. */
  static picksEntity(direction: DirectionEdit): boolean {
    return direction?.kind === 'edge' || direction?.kind === 'face';
  }

  /** A world axis or an origin plane the statement already names by its literal (`'z'`, `"xy"`). */
  private static writtenAs(direction: DirectionRef, text: string | null): boolean {
    const literal = text?.trim().match(/^['"](x|y|z|xy|xz|yz)['"]$/)?.[1];
    if (!literal) {
      return false;
    }
    return (direction.kind === 'standard' && direction.axis === literal)
      || (direction.kind === 'standard-plane' && direction.plane === literal);
  }

  /** A shown world axis or origin plane clicked while the row is armed. */
  private readonly onStandardPick = (name: StandardDatum): void => {
    if (this.aimed) {
      this.onPick?.(this.control.takeStandard(name));
    }
  };
}
