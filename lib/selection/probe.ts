import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Point } from "../math/point.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { EdgeConvexity, EdgeConvexityOps } from "../oc/edge-convexity.js";

/**
 * Geometric summary of a picked edge, used to instantiate filter atoms.
 * Only the *picked* sub-shapes are probed this way — universe members are
 * evaluated through the real filter predicates, never modeled.
 */
export type EdgeProbe = {
  /** The picked edge itself, for reference lookups (`belongsToFace(ref)`). */
  edge: Edge;
  props: EdgeProperties;
  /** First and last vertex points — what the plane-side predicates test. */
  ends: Point[];
  mid: Point;
  /** Center of mass — what the rank filters project onto a direction. */
  center: Point;
  /** Length — what `largest()`/`smallest()` compare edges by. */
  size: number;
  /** Surface properties of the owning solid's faces this edge bounds. */
  adjacentFaces: FaceProperties[];
  /** Outer corner, inner corner, or tangent transition within the owning solid. */
  convexity: EdgeConvexity | null;
};

export type FaceProbe = {
  props: FaceProperties;
  edgeProps: EdgeProperties[];
  /** Boundary vertex points — what the face plane-side predicates test. */
  points: Point[];
  edgeCount: number;
  /** Center of mass — what the rank filters project onto a direction. */
  center: Point;
  /** Area — what `largest()`/`smallest()` compare faces by. */
  size: number;
};

export function probeEdge(edge: Edge, ownerSolid: Shape | null): EdgeProbe {
  const props = EdgeProps.getProperties(edge.getShape());
  const adjacentFaces: FaceProperties[] = [];
  let convexity: EdgeConvexity | null = null;
  if (ownerSolid instanceof Solid) {
    const index = ownerSolid.getEdgeToFacesIndex();
    for (const raw of TopologyIndex.seekShapes(index, edge.getShape())) {
      adjacentFaces.push(FaceProps.getProperties(raw));
    }
    convexity = EdgeConvexityOps.classify(edge, ownerSolid);
  }
  return {
    edge,
    props,
    ends: edgeEndPoints(edge),
    mid: EdgeOps.getEdgeMidPoint(edge),
    center: ShapeMeasure.centerOfMass(edge),
    size: ShapeMeasure.size(edge),
    adjacentFaces,
    convexity,
  };
}

export function probeFace(face: Face): FaceProbe {
  const props = FaceProps.getProperties(face.getShape());
  const edges = face.getEdges();
  const edgeProps: EdgeProperties[] = [];
  const points: Point[] = [];
  for (const edge of edges) {
    edgeProps.push(EdgeProps.getProperties(edge.getShape()));
    points.push(...edgeEndPoints(edge));
    points.push(EdgeOps.getEdgeMidPoint(edge));
  }
  return {
    props, edgeProps, points, edgeCount: edges.length,
    center: ShapeMeasure.centerOfMass(face),
    size: ShapeMeasure.size(face),
  };
}

/** Endpoint samples of an edge — the points `above`/`below` filters test. */
export function edgeEndPoints(edge: Edge): Point[] {
  return [
    EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge)),
    EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge)),
  ];
}

/** Boundary vertex samples of a face — what its `above`/`below` filters test. */
export function faceBoundaryPoints(face: Face): Point[] {
  return face.getEdges().flatMap(edge => edgeEndPoints(edge));
}
