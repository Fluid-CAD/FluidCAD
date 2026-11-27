import {
  getEdgeProperties, getFaceProperties, type DirectionRef, type GhostDirectionRef, type SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { SelectedEntity } from '../../viewer';
import {
  AXIS_UNAVAILABLE_MESSAGE, axisLineShapeIds, axisOptionForLocation, axisOptionForShape, collectAxisOptions,
  labelWithAxisNames, type AxisOption,
} from './axis-options';
import { AxisSlotControl, type StandardAxis } from './axis-slot';
import { ConnectorOptions, type ConnectorOption } from './connector-options';
import { ConnectorPicks } from './connector-picks';
import {
  collectPlaneOptions, labelWithPlaneNames, planeOptionForLocation, planeOptionForShape, planeQuadShapeIds,
  resolvePlaneRow, type PlaneOption,
} from './plane-bases';
import { NO_CHANNELS, type PickChannels, type PickOutcome, type StandardDatum } from './schema/schema-pickers';

/** What a picked edge or face is, as a direction reads it: only a straight edge or a planar face gives one. */
export type DirectionGeometry = 'straight' | 'planar' | 'curved';

/**
 * What a direction slot holds, as an apply request names it
 * ({@link DirectionRef}), and as a preview request addresses it
 * ({@link GhostDirectionRef}): both live with the requests in the api.
 */
export type { DirectionRef, GhostDirectionRef };

/** Everything a direction slot holds, for the viewport highlight. */
export type DirectionSlotHighlight = {
  /** The picked edge or face. */
  entities: SelectedEntity[];
  /** A chosen axis statement's line. */
  wireIds: string[];
  /** A chosen plane statement's quad. */
  planeQuadIds: string[];
  /** A chosen world axis. */
  standardAxes: StandardAxis[];
  /** A chosen connector's scene id — its gizmo draws enlarged. */
  connectorIds: string[];
};

const PLANE_UNAVAILABLE_MESSAGE = 'That plane cannot be referenced — only plane() features can be picked.';

/** What the engine says a picked edge or face is; null when it cannot say. */
async function askEngine(entity: SelectedEntity): Promise<DirectionGeometry | null> {
  if (entity.sub.type === 'edge') {
    const props = await getEdgeProperties(entity.shapeId, entity.sub.index);
    return props ? (props.curveType === 'line' ? 'straight' : 'curved') : null;
  }
  const props = await getFaceProperties(entity.shapeId, entity.sub.index);
  return props ? (props.surfaceType === 'plane' || props.surfaceType === 'circle' ? 'planar' : 'curved') : null;
}

/**
 * A dialog row that collects a direction: the axis chip
 * ({@link AxisSlotControl}) taking a plane too, which stands for its normal.
 * While armed it wants the world axes and the origin planes shown
 * ({@link channels}) and takes a world axis, an `axis()` line, a straight
 * edge, a connector, an origin plane, a `plane()` quad or a planar face —
 * from the viewport or, for a statement, its timeline row. A curved edge or
 * face gives no direction: the engine is asked what the pick is, and a
 * curved one is refused with the row's message.
 *
 * The control owns the pick — the offered statements, re-found after each
 * render ({@link setScene}), and the picked edge or face, which dies with
 * the render that minted its id — and reports it as the requests carry it
 * ({@link value}, {@link ghost}). An edit opens on the statement's own
 * direction ({@link seedKeep}): a world-axis or origin-plane literal reads
 * as that axis or plane, anything else stays kept as written. The panel
 * owns arming and the service routes clicks in and repaints from
 * {@link highlight}; this control calls no viewer.
 */
export class DirectionSlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture in the slot changed the direction (the chip's ✕). */
  onChange?: () => void;

  private readonly slot: AxisSlotControl;
  private readonly classify: (entity: SelectedEntity) => Promise<DirectionGeometry | null>;
  private readonly refusal: string | undefined;
  private scene: SceneObjectRender[] = [];
  private axes: AxisOption[] = [];
  private planes: PlaneOption[] = [];
  private connectors: ConnectorOption[] = [];
  /** The picked edge or face behind the slot's edge or face chip. */
  private entity: SelectedEntity | null = null;
  /** Edit mode: what the engine resolved the statement's own direction to. */
  private keptSource: SourceSlotRef | null = null;
  /** Counts what changed the slot, so the answer about an overtaken click is dropped. */
  private turn = 0;

  constructor(
    host: HTMLElement,
    opts: {
      label?: string;
      prompt?: string;
      /** The row's message for a curved edge or face; default names which of the two it was. */
      refusal?: string;
      /** What a picked edge or face is; default asks the engine. */
      classify?: (entity: SelectedEntity) => Promise<DirectionGeometry | null>;
      /**
       * The direction may be left out: an edit's own direction has a ✕ that
       * empties the row ({@link value} null), where it is otherwise always
       * kept. Default off.
       */
      optional?: boolean;
    } = {},
  ) {
    this.classify = opts.classify ?? askEngine;
    this.refusal = opts.refusal;
    this.slot = new AxisSlotControl(host, {
      label: opts.label ?? 'Direction',
      prompt: opts.prompt,
      planes: true,
      clearable: opts.optional,
    });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onModeChange = () => {
      this.turn++;
      this.entity = null;
    };
    this.slot.onChange = () => this.onChange?.();
  }

  /**
   * The viewer channels the row needs while armed: edges and faces, `axis()`
   * lines and `plane()` quads, the world axes and the origin planes shown as
   * pick targets, and every connector gizmo.
   */
  channels(): PickChannels {
    return {
      ...NO_CHANNELS,
      pickFilter: 'all',
      axes: true,
      planes: true,
      standardAxes: true,
      standardPlanes: true,
      connectors: true,
    };
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** Fresh create-mode arming: no keep, no pick, the prompt. */
  reset(): void {
    this.turn++;
    this.entity = null;
    this.keptSource = null;
    this.slot.reset();
  }

  /**
   * Edit mode: the statement's own direction. A world-axis literal (`'z'`)
   * or an origin-plane literal (`'xy'`) reads as that axis or plane; anything
   * else stays a "Current: …" keep. `source` is what the engine resolved it
   * to, when it is already known ({@link setKeptSource}).
   */
  seedKeep(text: string | null, source: SourceSlotRef | null = null): void {
    this.turn++;
    this.entity = null;
    this.slot.seedKeep(text);
    this.setKeptSource(source);
  }

  /**
   * What the engine resolved the kept direction to: the statement it names,
   * the edge or face its selection is, the connector it is — what the kept
   * chip lights up and the preview reads. A connector shows as its own chip,
   * still kept as written.
   */
  setKeptSource(source: SourceSlotRef | null): void {
    this.keptSource = source;
    this.slot.setKeptConnector(source?.kind === 'connector'
      ? ConnectorOptions.forSite({ filePath: source.filePath, line: source.line, slot: source.slot }, this.connectors) ?? null
      : null);
  }

  /**
   * A new scene: the offered axis and plane statements and connectors
   * rebuild and a held one re-finds its own by call site (one that vanished
   * falls back to the statement's own direction, or the prompt); a picked
   * edge or face drops, since the render minted new ids. Answers whether a
   * pick the user made was dropped.
   */
  setScene(sceneObjects: SceneObjectRender[]): boolean {
    this.turn++;
    this.scene = sceneObjects;
    this.axes = collectAxisOptions(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    this.connectors = ConnectorOptions.collect(sceneObjects);
    const before = this.slot.direction;
    this.entity = null;
    if (before?.kind === 'edge') {
      this.slot.setEdgeChip(null);
    } else if (before?.kind === 'face') {
      this.slot.setFaceChip(null);
    }
    this.slot.setOptions(this.axes);
    this.slot.setPlaneOptions(this.planes);
    this.slot.setConnectorOptions(this.connectors);
    if (this.keptSource?.kind === 'connector') {
      this.setKeptSource(this.keptSource);
    }
    void this.relabel(sceneObjects);
    const picked = before !== null && before.kind !== 'keep';
    return picked && this.slot.direction?.kind !== before.kind;
  }

  /**
   * A viewport click on an edge or a face (an `axis()` line and a `plane()`
   * quad too, when the click carries one). A straight edge is taken as an
   * axis and a planar face as a plane; a curved one is refused with the
   * row's message. The engine says which it is, so the answer is a promise:
   * `ignored` when another pick, a render or a reset overtook the click.
   * Clicking the picked edge or face again clears it.
   */
  async takeClick(shapeId: string, sub: SubSelection): Promise<PickOutcome> {
    if (sub?.type === 'axis') {
      return this.takeAxisLine(shapeId);
    }
    if (sub?.type === 'plane') {
      return this.takePlaneQuad(shapeId);
    }
    if (sub?.type !== 'edge' && sub?.type !== 'face') {
      return 'ignored';
    }
    const entity: SelectedEntity = { shapeId, sub };
    if (this.entity && sameEntity(this.entity, entity)) {
      this.dropEntity();
      return 'taken';
    }
    const turn = ++this.turn;
    const geometry = await this.classify(entity).catch((): null => null);
    if (turn !== this.turn) {
      return 'ignored';
    }
    if (geometry === 'curved') {
      return {
        message: this.refusal ?? (sub.type === 'edge'
          ? 'That edge is curved — a direction is read from a straight edge.'
          : 'That face is curved — a direction is read from a planar face.'),
      };
    }
    this.entity = entity;
    if (sub.type === 'edge') {
      this.slot.setEdgeChip('Picked edge');
    } else {
      this.slot.setFaceChip('Picked face');
    }
    return 'taken';
  }

  /** An `axis()` line clicked. */
  takeAxisLine(shapeId: string): PickOutcome {
    const option = axisOptionForShape(shapeId, this.scene, this.axes);
    return option ? this.takeAxis(option) : { message: AXIS_UNAVAILABLE_MESSAGE };
  }

  /** A `plane()` quad clicked: its normal. */
  takePlaneQuad(shapeId: string): PickOutcome {
    const option = planeOptionForShape(shapeId, this.scene, this.planes);
    return option ? this.takePlane(option) : { message: PLANE_UNAVAILABLE_MESSAGE };
  }

  /** A world axis or an origin plane clicked in the viewport. */
  takeStandard(name: StandardDatum): PickOutcome {
    this.turn++;
    this.entity = null;
    if (name === 'x' || name === 'y' || name === 'z') {
      this.slot.selectStandard(name);
    } else {
      this.slot.selectStandardPlane(name);
    }
    return 'taken';
  }

  /** A connector gizmo clicked: the connector's Z axis through its origin. */
  takeConnector(connectorId: string): PickOutcome {
    const option = ConnectorOptions.forId(connectorId, this.connectors);
    if (!option) {
      return { message: ConnectorPicks.UNREFERENCEABLE };
    }
    this.turn++;
    this.entity = null;
    this.slot.selectConnector(option);
    return 'taken';
  }

  /** A timeline row: an `axis()`, a `plane()` or a connector is taken; any other row is `ignored`. */
  takeRow(row: SceneObjectRender): PickOutcome {
    if (row.type === 'connector') {
      return row.id != null ? this.takeConnector(row.id) : { message: ConnectorPicks.UNREFERENCEABLE };
    }
    if (row.type === 'axis' && row.sourceLocation) {
      const option = axisOptionForLocation(this.axes, row.sourceLocation);
      return option ? this.takeAxis(option) : { message: AXIS_UNAVAILABLE_MESSAGE };
    }
    const plane = resolvePlaneRow(row);
    if (plane?.sourceLocation) {
      const option = planeOptionForLocation(this.planes, plane.sourceLocation);
      return option ? this.takePlane(option) : { message: PLANE_UNAVAILABLE_MESSAGE };
    }
    return 'ignored';
  }

  /**
   * What Apply sends: the direction as its request ref, `keep` for the
   * edited statement's own direction left as written, or null while the
   * slot holds nothing.
   */
  value(): DirectionRef | { keep: true } | null {
    const state = this.slot.direction;
    switch (state?.kind) {
      case 'keep':
        return { keep: true };
      case 'standard':
        return { kind: 'standard', axis: state.axis };
      case 'standard-plane':
        return { kind: 'standard-plane', plane: state.plane };
      case 'axis':
      case 'plane': {
        const { filePath, line, column } = state.option;
        return { kind: state.kind, filePath, line, column };
      }
      case 'connector': {
        const { filePath, line, column, slot } = state.option;
        return { kind: 'connector', filePath, line, column, ...(slot !== undefined ? { slot } : {}) };
      }
      case 'edge':
      case 'face':
        return this.entity ? { kind: state.kind, entity: this.entity } : null;
      default:
        return null;
    }
  }

  /**
   * The direction as a preview request addresses it; a kept one as the
   * engine resolved it. Null when there is nothing a preview can read: no
   * direction yet, or a kept expression nothing stands in for.
   */
  ghost(): GhostDirectionRef | null {
    const state = this.slot.direction;
    switch (state?.kind) {
      case 'keep':
        return this.keptGhost();
      case 'standard':
        return { kind: 'standard', axis: state.axis };
      case 'standard-plane':
        return { kind: 'standard-plane', plane: state.plane };
      case 'axis':
      case 'plane':
        return { kind: state.kind, filePath: state.option.filePath, line: state.option.line };
      case 'connector': {
        const { filePath, line, slot } = state.option;
        return { kind: 'connector', filePath, line, ...(slot !== undefined ? { slot } : {}) };
      }
      case 'edge':
      case 'face':
        return this.entity ? { kind: state.kind, shapeId: this.entity.shapeId, index: this.entity.sub.index } : null;
      default:
        return null;
    }
  }

  /** Everything the row holds, for the viewport highlight; a kept direction lights what the engine resolved it to. */
  highlight(): DirectionSlotHighlight {
    const lit: DirectionSlotHighlight = { entities: [], wireIds: [], planeQuadIds: [], standardAxes: [], connectorIds: [] };
    const state = this.slot.direction;
    if (state?.kind === 'standard') {
      lit.standardAxes.push(state.axis);
    } else if (state?.kind === 'axis') {
      lit.wireIds.push(...axisLineShapeIds(state.option, this.scene));
    } else if (state?.kind === 'plane') {
      lit.planeQuadIds.push(...planeQuadShapeIds(state.option, this.scene));
    } else if ((state?.kind === 'edge' || state?.kind === 'face') && this.entity) {
      lit.entities.push(this.entity);
    } else if (state?.kind === 'keep' && this.keptSource?.kind === 'sketch') {
      lit.wireIds.push(...axisLineShapeIds(this.keptSource, this.scene));
      lit.planeQuadIds.push(...planeQuadShapeIds(this.keptSource, this.scene));
    } else if (state?.kind === 'keep' && this.keptSource?.kind === 'entities') {
      lit.entities.push(...this.keptSource.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
    }
    const connector = this.slot.connector;
    if (connector) {
      lit.connectorIds.push(connector.id);
    }
    return lit;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private takeAxis(option: AxisOption): PickOutcome {
    this.turn++;
    this.entity = null;
    this.slot.selectOption(option);
    return 'taken';
  }

  private takePlane(option: PlaneOption): PickOutcome {
    this.turn++;
    this.entity = null;
    this.slot.selectPlane(option);
    return 'taken';
  }

  /** Clear the picked edge or face: back to the statement's own direction (edit mode), else the prompt. */
  private dropEntity(): void {
    this.turn++;
    const face = this.entity?.sub.type === 'face';
    this.entity = null;
    if (face) {
      this.slot.setFaceChip(null);
    } else {
      this.slot.setEdgeChip(null);
    }
  }

  /**
   * The kept direction as a preview reads it: a connector by its site, the
   * `axis()` or `plane()` statement it names — whichever this scene offers
   * at that call site — or the one edge or face its selection is.
   */
  private keptGhost(): GhostDirectionRef | null {
    const source = this.keptSource;
    if (source?.kind === 'connector') {
      return { kind: 'connector', filePath: source.filePath, line: source.line, ...(source.slot !== undefined ? { slot: source.slot } : {}) };
    }
    if (source?.kind === 'sketch') {
      const loc = { filePath: source.filePath, line: source.line };
      if (planeOptionForLocation(this.planes, loc)) {
        return { kind: 'plane', ...loc };
      }
      return axisOptionForLocation(this.axes, loc) ? { kind: 'axis', ...loc } : null;
    }
    if (source?.kind === 'entities' && source.entities.length === 1) {
      const { shapeId, sub } = source.entities[0];
      return sub.type === 'edge' || sub.type === 'face' ? { kind: sub.type, shapeId, index: sub.index } : null;
    }
    return null;
  }

  /**
   * Name the offered axis and plane statements after the variables they are
   * bound to. The lookup is async: its answer is dropped when the scene
   * moved on meanwhile.
   */
  private async relabel(scene: SceneObjectRender[]): Promise<void> {
    const [axes, planes] = await Promise.all([labelWithAxisNames(this.axes), labelWithPlaneNames(this.planes)]);
    if (this.scene !== scene) {
      return;
    }
    this.axes = axes;
    this.planes = planes;
    this.slot.setOptions(axes);
    this.slot.setPlaneOptions(planes);
  }
}
