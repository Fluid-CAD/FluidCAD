import { fetchConnectorAnchors, type EndInputRef, type EndSourceSlotRef, type GhostEndRef } from '../../api';
import { SceneIndex } from '../../helpers/scene-index';
import { modelShapeIdsOf } from '../../helpers/scene-utils';
import type { SceneObjectPart, SceneObjectRender, SubSelection, Vec3Data } from '../../types';
import type { SelectedEntity, Viewer } from '../../viewer';
import { AnchorSuggestions, type LockedAnchor } from './anchor-suggestions';
import { ConnectorGhostOverlay } from './connector-ghost';
import type { EndPick, EndSlotControl } from './end-slot';
import type { ExtraPickRow, ExtraRowHighlight } from './extra-pick-row';
import { NO_CHANNELS, type PickChannels, type PickOutcome } from './schema/schema-pickers';

/**
 * What a picked shape is, as an end reads it: a body (a solid or a
 * surface, whose vertex is a corner), a curve object, an edge of a sketch,
 * or a point (a sketch point).
 */
export type EndOwnerKind = 'body' | 'curve' | 'sketch-edge' | 'point';

/** The row and the shape a pick landed on, and what that makes it. */
export type EndOwner = { row: SceneObjectRender; shape: SceneObjectPart; kind: EndOwnerKind };

/** What a closed edge (a full circle) is told: it offers no start or end. */
export const CLOSED_EDGE_REFUSAL = 'A closed edge has no start or end — pick an open edge near one of its ends, or a point.';

/** What a vertex nothing can name is told. */
const UNNAMED_VERTEX = 'That point cannot be an end — pick a corner, a point, or near the end of an edge.';

/**
 * One end row of a dialog (Bridge's From and To; fill guides and ruled's
 * `.to(point)` next): the {@link EndSlotControl}, with what the service
 * does for it. While armed it picks edges and vertices:
 *
 * - **Hovering an edge** floats its nearer end, the start or the end of the
 *   edge in its own sense (by its curve's parameter) — the anchor
 *   suggestions the connector dialog offers for locations, limited to the
 *   two ends ({@link AnchorSuggestions}). A closed edge offers none.
 * - **A click on an edge** takes the end floated nearest the click: the
 *   edge's start or end (`edge-end`) for an edge of a solid, a surface or
 *   a curve; for an edge of a sketch — which no selector names — the
 *   sketch vertex at that end, which carries the edge's direction.
 * - **A click on a vertex** takes that vertex: a corner of a solid or a
 *   surface, or a point, both of which offer their position only
 *   ({@link EndPick.positionOnly}); a sketch edge's end or a curve's vertex,
 *   which keep their direction.
 *
 * It answers the end as each request carries it: {@link createValue},
 * {@link editValue}, {@link ghost}. A picked edge or vertex dies with the
 * render that minted its id; an edit's own end, kept as written, does not.
 */
export class EndRow implements ExtraPickRow {
  onPick?: (outcome: PickOutcome) => void;
  readonly rowRefusal = 'gives no end — pick near the end of an edge or a curve, or a point, in the viewport.';
  readonly pickedNoun = 'ends';

  private readonly overlay: ConnectorGhostOverlay;
  private readonly rail: AnchorSuggestions;
  private scene: SceneObjectRender[] = [];
  /** The anchor suggestion the row's edge end was locked from, so hovering it floats no faint twin. */
  private locked: { key: string; index: number } | null = null;

  constructor(
    private readonly control: EndSlotControl,
    private readonly viewer: Viewer,
    private readonly opts: {
      /** Why the row cannot take `input` — the other end already holds it — or null. */
      refuse?: (input: EndInputRef) => string | null;
    } = {},
  ) {
    this.overlay = new ConnectorGhostOverlay(viewer);
    this.rail = new AnchorSuggestions(viewer, this.overlay, {
      // An end is read wherever it is, inside a part or not: asked as a hole placement is.
      purpose: 'hole',
      offers: anchor => anchor.kind === 'start' || anchor.kind === 'end',
      offersRefusal: CLOSED_EDGE_REFUSAL,
      isTaken: (key, index) => this.locked?.key === key && this.locked.index === index && this.control.pick !== null,
      request: fetchConnectorAnchors,
    });
    this.rail.onLock = locked => this.onPick?.(this.takeAnchor(locked));
    this.rail.onRefuse = reason => this.onPick?.({ message: reason ?? 'That edge offers no end to take.' });
  }

  /** Edges, with vertex dots tried ahead of them; the anchor suggestions float on the hovered edge. */
  channels(): PickChannels {
    return { ...NO_CHANNELS, pickFilter: 'edge', vertices: true, anchors: true };
  }

  aim(armed: boolean): void {
    this.rail.setEnabled(armed);
  }

  hover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    this.rail.handleHover(shapeId, sub, clientX, clientY);
  }

  /**
   * A vertex is taken at once. An edge goes to the anchor suggestions,
   * which lock the end nearest the click — at once when the hover already
   * has the edge's ends, else once the engine answers — and land it through
   * {@link onPick}.
   */
  async takeClick(shapeId: string, sub: NonNullable<SubSelection>): Promise<PickOutcome> {
    if (sub.type === 'vertex') {
      return this.takeVertex(shapeId, sub);
    }
    if (sub.type === 'edge') {
      this.rail.handleClick(shapeId, sub);
    }
    return 'ignored';
  }

  /** No timeline row is an end: a curve's row says nothing of which end. */
  takeRow(_row: SceneObjectRender): PickOutcome {
    return 'ignored';
  }

  /** The anchors' answers die with a render; with `dropEntities` so does a picked edge or vertex, whose id the render re-minted. */
  setScene(sceneObjects: SceneObjectRender[], opts: { dropEntities: boolean }): boolean {
    this.scene = sceneObjects;
    this.rail.clear();
    if (opts.dropEntities && this.control.pick !== null) {
      this.locked = null;
      this.control.clear();
      return true;
    }
    return false;
  }

  /** The picked edge and the dot at its end, or the picked vertex; an edit's own end as the engine resolved it. */
  paint(): ExtraRowHighlight {
    const pick = this.control.pick;
    if (pick) {
      return { entities: pick.entities, wireIds: [], planeQuadIds: [] };
    }
    const kept = this.control.keptSource;
    if (kept?.kind === 'edge-end') {
      return { entities: [{ shapeId: kept.entity.shapeId, sub: { type: 'edge', index: kept.entity.sub.index } }], wireIds: [], planeQuadIds: [] };
    }
    if (kept?.kind === 'curve-end') {
      const row = this.scene.find(obj => obj.sourceLocation?.filePath === kept.filePath && obj.sourceLocation.line === kept.line);
      return { entities: [], wireIds: row ? modelShapeIdsOf(row, this.scene, ['curve']) : [], planeQuadIds: [] };
    }
    return { entities: [], wireIds: [], planeQuadIds: [] };
  }

  close(): void {}

  release(): void {
    this.rail.setEnabled(false);
    this.overlay.clear();
    this.viewer.pickVertices = false;
    this.viewer.setVertexPickScope(null);
  }

  /** Edit mode: the statement's own end, as written, for a "Current: …" chip. */
  seedKeep(text: string): void {
    this.locked = null;
    this.control.seedKeep(text);
  }

  /** What the engine resolved the statement's own end to — null when it could not say. */
  setKeptSource(source: EndSourceSlotRef | null): void {
    this.control.setKeptSource(source);
  }

  /** The create request's end: the pick, or null while the row holds none. */
  createValue(): EndInputRef | null {
    return this.control.pick?.input ?? null;
  }

  /** An edit's end: the new pick, or undefined while the row keeps the statement's own. */
  editValue(): EndInputRef | undefined {
    return this.control.pick?.input;
  }

  /** The row holds a picked edge or vertex, which an edit synthesizes against the session boundary. */
  get picksGeometry(): boolean {
    const input = this.control.pick?.input;
    return input !== undefined && input.kind !== 'curve-end';
  }

  /**
   * The end on the preview wire: the pick, or an edit's own end as the
   * engine resolved it — null while there is none, or the engine resolved
   * it to nothing the preview addresses (a point it keeps as written).
   */
  ghost(): GhostEndRef | null {
    const pick = this.control.pick;
    if (pick) {
      const input = pick.input;
      return input.kind === 'curve-end'
        ? { kind: 'curve-end', filePath: input.filePath, line: input.line, end: input.end }
        : input;
    }
    const kept = this.control.keptSource;
    if (kept?.kind === 'edge-end') {
      return { kind: 'edge-end', shapeId: kept.entity.shapeId, index: kept.entity.sub.index, end: kept.end };
    }
    if (kept?.kind === 'curve-end') {
      return { kind: 'curve-end', filePath: kept.filePath, line: kept.line, end: kept.end };
    }
    return null;
  }

  /** The two ends name the same thing: an edge's same end, a curve's same end, the same vertex. */
  static sameEnd(a: EndInputRef | null | undefined, b: EndInputRef | null | undefined): boolean {
    if (!a || !b || a.kind !== b.kind) {
      return false;
    }
    if (a.kind === 'curve-end' && b.kind === 'curve-end') {
      return a.filePath === b.filePath && a.line === b.line && a.column === b.column && a.end === b.end;
    }
    if (a.kind === 'curve-end' || b.kind === 'curve-end') {
      return false;
    }
    return a.shapeId === b.shapeId && a.index === b.index && (a.kind === 'vertex' || (b.kind === 'edge-end' && a.end === b.end));
  }

  /**
   * The row and shape `shapeId` stands for, and what that makes a pick on
   * it: a body's (solid or surface), a curve object's, a sketch edge's, or a
   * point's — null for anything else (a plane's quad).
   */
  static ownerOf(shapeId: string, sceneObjects: SceneObjectRender[]): EndOwner | null {
    for (const row of sceneObjects) {
      const shape = (row.sceneShapes ?? []).find(candidate => candidate.shapeId === shapeId);
      if (!shape) {
        continue;
      }
      const kind = EndRow.kindOf(row, shape, sceneObjects);
      return kind ? { row, shape, kind } : null;
    }
    return null;
  }

  /**
   * The topology vertex of `shape` nearest `point` — where an edge's end
   * sits among the vertex dots the viewer draws. Null for a shape that
   * lists none.
   */
  static nearestVertex(shape: SceneObjectPart, point: Vec3Data): number | null {
    const coordinates = shape.vertices ?? [];
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 2 < coordinates.length; i += 3) {
      const distance = (coordinates[i] - point.x) ** 2 + (coordinates[i + 1] - point.y) ** 2 + (coordinates[i + 2] - point.z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i / 3;
      }
    }
    return best;
  }

  private static kindOf(row: SceneObjectRender, shape: SceneObjectPart, sceneObjects: SceneObjectRender[]): EndOwnerKind | null {
    if (shape.shapeType === 'solid' || shape.shapeType === 'surface') {
      return 'body';
    }
    if (shape.shapeType === 'vertex') {
      return 'point';
    }
    if (shape.shapeType === 'edge' || shape.shapeType === 'wire') {
      const inSketch = row.type === 'sketch' || SceneIndex.of(sceneObjects).enclosing(row, 'sketch') !== undefined;
      return inSketch ? 'sketch-edge' : 'curve';
    }
    return null;
  }

  /** A vertex: a body's corner and a point at their position only; a sketch edge's end and a curve's vertex with their direction. */
  private takeVertex(shapeId: string, sub: Extract<SubSelection, { type: 'vertex' }>): PickOutcome {
    const owner = EndRow.ownerOf(shapeId, this.scene);
    if (!owner) {
      return { message: UNNAMED_VERTEX };
    }
    const entity: SelectedEntity = { shapeId, sub: { type: 'vertex', index: sub.index, position: sub.position } };
    const looks: Record<EndOwnerKind, Pick<EndPick, 'label' | 'positionOnly'>> = {
      body: { label: 'Corner', positionOnly: 'corner' },
      point: { label: 'Point', positionOnly: 'point' },
      'sketch-edge': { label: 'Sketch edge end', positionOnly: null },
      curve: { label: 'Curve vertex', positionOnly: null },
    };
    return this.take({ input: { kind: 'vertex', shapeId, index: sub.index }, entities: [entity], ...looks[owner.kind] }, null);
  }

  /**
   * The end an anchor suggestion locked: the edge's start or end, or — on
   * an edge of a sketch, which no selector names — the sketch vertex at
   * that end.
   */
  private takeAnchor(locked: LockedAnchor): PickOutcome {
    const candidate = locked.anchors[locked.anchorIndex];
    const end = candidate?.anchor.kind;
    if (end !== 'start' && end !== 'end') {
      return { message: CLOSED_EDGE_REFUSAL };
    }
    const { shapeId } = locked.entity;
    const index = locked.entity.sub.index;
    const owner = EndRow.ownerOf(shapeId, this.scene);
    const point = candidate.frame.origin;
    const vertex = owner ? EndRow.nearestVertex(owner.shape, point) : null;
    const dot: SelectedEntity[] = vertex === null ? [] : [{ shapeId, sub: { type: 'vertex', index: vertex, position: point } }];
    if (owner?.kind === 'sketch-edge') {
      if (vertex === null) {
        return { message: UNNAMED_VERTEX };
      }
      return this.take({ input: { kind: 'vertex', shapeId, index: vertex }, label: 'Sketch edge end', positionOnly: null, entities: dot }, null);
    }
    const word = end === 'start' ? 'start' : 'end';
    return this.take({
      input: { kind: 'edge-end', shapeId, index, end },
      label: owner?.kind === 'curve' ? `Curve edge ${word}` : `Edge ${word}`,
      positionOnly: null,
      entities: [{ shapeId, sub: { type: 'edge', index } }, ...dot],
    }, { key: locked.key, index: locked.anchorIndex });
  }

  /** The row takes `pick` — unless the other end already holds the same. */
  private take(pick: EndPick, locked: { key: string; index: number } | null): PickOutcome {
    const refusal = this.opts.refuse?.(pick.input);
    if (refusal) {
      return { message: refusal };
    }
    this.locked = locked;
    this.control.take(pick);
    return 'taken';
  }
}
