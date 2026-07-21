import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Point } from "../math/point.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { TopologyIndex } from "../oc/topology-index.js";

/**
 * Geometric summary of a picked edge, used to instantiate filter atoms.
 * Only the *picked* sub-shapes are probed this way — universe members are
 * evaluated through the real filter predicates, never modeled.
 */
export type EdgeProbe = {
  props: EdgeProperties;
  /** First and last vertex points — what the plane-side predicates test. */
  ends: Point[];
  mid: Point;
  /** Surface properties of the owning solid's faces this edge bounds. */
  adjacentFaces: FaceProperties[];
};

export type FaceProbe = {
  props: FaceProperties;
  edgeProps: EdgeProperties[];
  /** Boundary vertex points — what the face plane-side predicates test. */
  points: Point[];
  edgeCount: number;
};

export function probeEdge(edge: Edge, ownerSolid: Shape | null): EdgeProbe {
  const props = EdgeProps.getProperties(edge.getShape());
  const adjacentFaces: FaceProperties[] = [];
  if (ownerSolid instanceof Solid) {
    const index = ownerSolid.getEdgeToFacesIndex();
    for (const raw of TopologyIndex.seekShapes(index, edge.getShape())) {
      adjacentFaces.push(FaceProps.getProperties(raw));
    }
  }
  return {
    props,
    ends: edgeEndPoints(edge),
    mid: EdgeOps.getEdgeMidPoint(edge),
    adjacentFaces,
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
  return { props, edgeProps, points, edgeCount: edges.length };
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
