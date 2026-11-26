import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import type { BodyShape } from "../common/body-shape.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { FaceQuery } from "../oc/face-query.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { EdgeConvexity, EdgeConvexityOps } from "../oc/edge-convexity.js";
import type { BodyKind } from "../filters/body-kind.js";

/**
 * Geometric summary of a picked edge, used to instantiate filter atoms.
 * Only the *picked* sub-shapes are probed this way — universe members are
 * evaluated through the real filter predicates, never modeled.
 */
export type EdgeProbe = {
  /** The picked edge itself, for reference lookups (`belongsToFace(ref)`). */
  edge: Edge;
  props: EdgeProperties;
  /**
   * A line, a circle or an arc (see `EdgeQuery.isLineOrCircular`): what the
   * predicates judge by end vertices and chords. Any other curve is judged
   * along its whole extent, and is never `verticalTo` a plane.
   */
  lineOrCircular: boolean;
  /** The kind of body the edge belongs to, as `ofSolid()` / `ofSurface()` read it; null for a curve's edge. */
  bodyKind: BodyKind | null;
  /** First and last vertex points — what the plane-side predicates test. */
  ends: Point[];
  mid: Point;
  /** Center of mass — what the rank filters project onto a direction. */
  center: Point;
  /** Length — what `largest()`/`smallest()` compare edges by. */
  size: number;
  /** Surface properties of the owning body's faces this edge bounds. */
  adjacentFaces: FaceProperties[];
  /** The same faces as wrappers, for loop lookups (`outerOf(ref)` / `holeOf(ref)`). */
  owningFaces: Face[];
  /** Outer corner, inner corner, or tangent transition within the owning body. */
  convexity: EdgeConvexity | null;
};

export type FaceProbe = {
  /** The picked face itself. */
  face: Face;
  props: FaceProperties;
  /** The kind of body the face belongs to, as `ofSolid()` / `ofSurface()` read it. */
  bodyKind: BodyKind | null;
  /** The face's mean outward normal, as `facing()` reads it; null for a face that faces nowhere. */
  meanNormal: Vector3d | null;
  edgeProps: EdgeProperties[];
  /** The boundary edges' end vertices and midpoints: what shared-plane atoms and the `above` / `below` cuts read a face by. */
  points: Point[];
  edgeCount: number;
  /** Center of mass — what the rank filters project onto a direction. */
  center: Point;
  /** Area — what `largest()`/`smallest()` compare faces by. */
  size: number;
};

/**
 * Probe a picked edge. `owner` is the shape the pick was made on: a solid
 * or a surface the edge bounds faces of, or a curve standing on its own.
 */
export function probeEdge(edge: Edge, owner: Shape | null): EdgeProbe {
  const props = EdgeProps.of(edge);
  const adjacentFaces: FaceProperties[] = [];
  const owningFaces: Face[] = [];
  let convexity: EdgeConvexity | null = null;
  const body = bodyOf(owner);
  if (body) {
    const index = body.getEdgeToFacesIndex();
    const wrappers = body.getFaces();
    for (const raw of TopologyIndex.seekShapes(index, edge.getShape())) {
      const wrapper = wrappers.find(f => f.getShape().IsSame(raw));
      // The body's own wrapper keeps the face's class; a face it does not hold is classified afresh.
      adjacentFaces.push(wrapper ? FaceProps.of(wrapper) : FaceProps.getProperties(raw));
      if (wrapper) {
        owningFaces.push(wrapper);
      }
    }
    convexity = EdgeConvexityOps.classify(edge, body);
  }
  return {
    edge,
    props,
    lineOrCircular: EdgeQuery.isLineOrCircular(edge),
    bodyKind: body ? bodyKindOf(body) : null,
    ends: [...EdgeOps.endPoints(edge)],
    mid: EdgeOps.getEdgeMidPoint(edge),
    center: ShapeMeasure.centerOfMass(edge),
    size: ShapeMeasure.size(edge),
    adjacentFaces,
    owningFaces,
    convexity,
  };
}

/** Probe a picked face. `owner` is the body the pick was made on. */
export function probeFace(face: Face, owner: Shape | null): FaceProbe {
  const props = FaceProps.of(face);
  const body = bodyOf(owner);
  const edges = face.getEdges();
  const edgeProps: EdgeProperties[] = [];
  const points: Point[] = [];
  for (const edge of edges) {
    edgeProps.push(EdgeProps.of(edge));
    points.push(...EdgeOps.endPoints(edge));
    points.push(EdgeOps.getEdgeMidPoint(edge));
  }
  return {
    face, props, edgeProps, points, edgeCount: edges.length,
    bodyKind: body ? bodyKindOf(body) : null,
    meanNormal: FaceQuery.meanNormal(face),
    center: ShapeMeasure.centerOfMass(face),
    size: ShapeMeasure.size(face),
  };
}

/** The body a pick was made on, or null for a curve or no shape at all. */
function bodyOf(owner: Shape | null): BodyShape | null {
  return owner && owner.isBody() ? owner as BodyShape : null;
}

/** A body's kind, as `BodyKindFilter` reads it. */
export function bodyKindOf(body: Shape): BodyKind {
  return body.isSolid() ? 'solid' : 'surface';
}
