// Fixed reference entities (P6): the outputs of project()/intersect() inside
// a solved sketch register into the solver system as LOCKED geometry —
// params present but excluded from the solve — so constraints can target a
// projected bore or edge (tangent, coincident, dimensions). Registration
// happens in the sketch's pre-solve pass (the OCCT geometry only exists at
// build time), which is why constraints referencing them resolve deferred.

import { Edge } from "../../../common/edge.js";
import { LazyVertex } from "../../lazy-vertex.js";
import { Vertex } from "../../../common/vertex.js";
import { Point2D } from "../../../math/point.js";
import { Plane } from "../../../math/plane.js";
import { EdgeProps } from "../../../oc/edge-props.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import type { SceneObject } from "../../../common/scene-object.js";
import type { PointRole } from "../../../sketch-solver/index.js";
import type { SketchSolverContext } from "./solver-context.js";

/** One representable projected/sectioned edge, registered as a fixed entity. */
export type ReferenceEntityRecord = {
  /** Solver entity id (fixed). */
  entityId: number;
  kind: 'line' | 'circle' | 'arc';
  /** Index into the producer's emitted edge array — the `.ref(i)` address. */
  edgeIndex: number;
};

/**
 * What Projection/Intersect implement to participate as reference producers.
 * `prepareReferences` is idempotent: the sketch's pre-solve pass calls it
 * before the solve; the normal build() slot calls it again and consumes the
 * cached result (or re-throws the cached error).
 */
export interface ReferenceProducer extends SceneObject {
  prepareReferences(): void;
  /** Registered records, in edge order. Empty before prepare. */
  referenceEntities(): ReferenceEntityRecord[];
  /** Total emitted edges (representable or not). 0 before prepare. */
  referenceEdgeCount(): number;
}

export function isReferenceProducer(obj: SceneObject): obj is ReferenceProducer {
  const candidate = obj as unknown as Partial<ReferenceProducer>;
  return typeof candidate.prepareReferences === 'function'
    && typeof candidate.referenceEntities === 'function';
}

/**
 * Classify prepared edges and register the representable ones (line, full
 * circle, circular arc) as fixed entities. Ellipses/splines still render and
 * feed profiles — they just get no solver identity, and a `.ref(i)` naming
 * one errors with the curve type.
 */
export function registerReferenceEntities(
  owner: SceneObject,
  ctx: SketchSolverContext,
  plane: Plane,
  edges: Edge[],
): ReferenceEntityRecord[] {
  const records: ReferenceEntityRecord[] = [];
  edges.forEach((edge, edgeIndex) => {
    const props = EdgeProps.getProperties(edge.getShape());
    if (props.curveType === 'line') {
      const s = plane.worldToLocal(edge.getFirstVertex().toPoint());
      const e = plane.worldToLocal(edge.getLastVertex().toPoint());
      const entityId = ctx.addLine(owner, s.x, s.y, e.x, e.y, { fixed: true });
      records.push({ entityId, kind: 'line', edgeIndex });
    } else if (props.curveType === 'circle') {
      const data = EdgeQuery.getCircleDataFromEdge(edge);
      const c = plane.worldToLocal(data.center);
      const entityId = ctx.addCircle(owner, c.x, c.y, data.radius, { fixed: true });
      records.push({ entityId, kind: 'circle', edgeIndex });
    } else if (props.curveType === 'arc') {
      const data = EdgeQuery.getCircleDataFromEdge(edge);
      const c = plane.worldToLocal(data.center);
      const s = plane.worldToLocal(edge.getFirstVertex().toPoint());
      const e = plane.worldToLocal(edge.getLastVertex().toPoint());
      const entityId = ctx.addArc(owner, c.x, c.y, s.x, s.y, e.x, e.y, { fixed: true });
      records.push({ entityId, kind: 'arc', edgeIndex });
    }
  });
  return records;
}

/**
 * Center meta vertices for the circle/arc members of a reference producer's
 * output — the same dot a native circle()/arc() emits (a hover-only overlay
 * would otherwise be the only sign of a projected bore's center). Meta
 * shapes stay out of profiles and edge indexing, so the edgeIndex join of
 * the records above is unaffected.
 */
export function centerMetaVertices(edges: Edge[]): Vertex[] {
  const centers: Vertex[] = [];
  for (const edge of edges) {
    const props = EdgeProps.getProperties(edge.getShape());
    if (props.curveType !== 'circle' && props.curveType !== 'arc') {
      continue;
    }
    const vertex = Vertex.fromPoint(EdgeQuery.getCircleDataFromEdge(edge).center);
    vertex.markAsMetaShape();
    centers.push(vertex);
  }
  return centers;
}

/** The producer's label for error messages: `projection (line 5)`. */
function labelOf(owner: ReferenceProducer): string {
  const loc = owner.getSourceLocation();
  return loc ? `${owner.getType()} (line ${loc.line})` : owner.getType();
}

/**
 * Resolve `.ref(i)` (or the single-entity sugar, index null) to a registered
 * entity id. Runs at deferred-constraint resolution time — after the
 * pre-solve pass — so the records exist for a well-formed model.
 */
export function referenceEntityId(owner: ReferenceProducer, index: number | null, what: string): number {
  const records = owner.referenceEntities();
  if (index === null) {
    if (records.length === 1) {
      return records[0].entityId;
    }
    if (records.length === 0) {
      throw new Error(`${what}: ${labelOf(owner)} produced no constrainable geometry (lines, circles or arcs)`);
    }
    throw new Error(`${what}: ${labelOf(owner)} produced ${records.length} constrainable edges — pick one with .ref(i)`);
  }
  const record = records.find(r => r.edgeIndex === index);
  if (record) {
    return record.entityId;
  }
  const count = owner.referenceEdgeCount();
  if (index < 0 || index >= count) {
    throw new Error(`${what}: ${labelOf(owner)} has ${count} edge${count === 1 ? '' : 's'} — .ref(${index}) is out of range`);
  }
  throw new Error(`${what}: edge ${index} of ${labelOf(owner)} is not a line, circle or arc — it cannot be constrained yet`);
}

/**
 * A `.ref(i)` handle — a whole reference entity as a constraint target.
 * Resolution is deferred: the id only exists after the pre-solve pass.
 */
export class ReferenceEntityRef {
  constructor(readonly owner: ReferenceProducer, readonly index: number | null) {}

  start(): ReferencePointRef {
    return new ReferencePointRef(this.owner, this.index, 'start');
  }

  end(): ReferencePointRef {
    return new ReferencePointRef(this.owner, this.index, 'end');
  }

  center(): ReferencePointRef {
    return new ReferencePointRef(this.owner, this.index, 'center');
  }
}

/**
 * A named point of a reference entity (`p.ref(0).center()`).
 * LazyVertex-compatible so it resolves as a plain point wherever one is
 * accepted — reading the FIXED registered params via the owner's records.
 */
export class ReferencePointRef extends LazyVertex {
  constructor(
    readonly refOwner: ReferenceProducer,
    readonly index: number | null,
    readonly role: PointRole,
  ) {
    super(`ref-${role}-${index ?? 'only'}`, () => {
      const point = referencePointValue(refOwner, index, role);
      return [Vertex.fromPoint2D(point)];
    });
  }
}

function referencePointValue(owner: ReferenceProducer, index: number | null, role: PointRole): Point2D {
  const entityId = referenceEntityId(owner, index, `ref ${role}`);
  const solver = (owner as unknown as { sketch: { solver(): SketchSolverContext | null } | null }).sketch?.solver();
  if (!solver) {
    throw new Error(`ref ${role}: the reference is not inside a constraint sketch`);
  }
  const params = solver.entityParams(entityId);
  const record = owner.referenceEntities().find(r => r.entityId === entityId)!;
  // Param layouts: line [sx,sy,ex,ey], circle [cx,cy,r], arc [cx,cy,r,sx,sy,ex,ey].
  if (record.kind === 'line') {
    if (role === 'center') {
      throw new Error('ref center: a projected line has no center point');
    }
    return role === 'start' ? new Point2D(params[0], params[1]) : new Point2D(params[2], params[3]);
  }
  if (record.kind === 'circle') {
    if (role !== 'center') {
      throw new Error(`ref ${role}: a projected circle only has a center point`);
    }
    return new Point2D(params[0], params[1]);
  }
  if (role === 'center') {
    return new Point2D(params[0], params[1]);
  }
  return role === 'start' ? new Point2D(params[3], params[4]) : new Point2D(params[5], params[6]);
}
