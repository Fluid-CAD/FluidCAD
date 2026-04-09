import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";

/**
 * Classifies edges and faces from cleaned result shapes by comparing with
 * original stock shapes. Edges/faces not present in stock are "section" geometry
 * created by the cut. Section edges are further classified by signed distance
 * from the cut plane into start, end, and internal groups.
 *
 * Sets state keys on target: section-edges, start-edges, end-edges,
 * internal-edges, internal-faces
 */
export function classifyCutResult(
  target: SceneObject,
  stockShapes: Shape[],
  cleanedShapes: Shape[],
  plane: Plane,
  cutDistance: number,
): void {
  // Collect stock edge midpoints for geometric comparison
  const stockEdgeMidpoints: Point[] = [];

  for (const stock of stockShapes) {
    const edges = Explorer.findEdgesWrapped(stock);
    for (const edge of edges) {
      stockEdgeMidpoints.push(EdgeOps.getEdgeMidPoint(edge));
    }
  }

  const tolerance = 1e-6;
  const isStockEdge = (edge: Edge): boolean => {
    const mid = EdgeOps.getEdgeMidPoint(edge);
    return stockEdgeMidpoints.some(sm =>
      Math.abs(mid.x - sm.x) < tolerance &&
      Math.abs(mid.y - sm.y) < tolerance &&
      Math.abs(mid.z - sm.z) < tolerance
    );
  };

  // Find section edges from cleaned result (edges not in stock)
  const sectionEdges: Edge[] = [];

  for (const shape of cleanedShapes) {
    const edges = Explorer.findEdgesWrapped(shape);
    for (const edge of edges) {
      if (!isStockEdge(edge)) {
        sectionEdges.push(edge);
      }
    }
  }

  // Internal faces: faces where ALL edges are section edges (not from stock).
  const internalFaces: Face[] = [];

  for (const shape of cleanedShapes) {
    const faces = Explorer.findFacesWrapped(shape);
    for (const f of faces) {
      const faceEdges = (f as Face).getEdges();
      if (faceEdges.length > 0 && faceEdges.every(e => !isStockEdge(e))) {
        internalFaces.push(f as Face);
      }
    }
  }

  // Classify section edges by signed distance from cut plane
  const startEdges: Edge[] = [];
  const endEdges: Edge[] = [];
  const internalEdges: Edge[] = [];

  if (plane && sectionEdges.length > 0) {
    const isThroughAll = cutDistance === 0;

    const dists = sectionEdges.map(edge => ({
      edge,
      d: plane.signedDistanceToPoint(EdgeOps.getEdgeMidPoint(edge))
    }));

    const startDist = isThroughAll ? Math.max(...dists.map(e => e.d)) : 0;
    const endDist = isThroughAll ? Math.min(...dists.map(e => e.d)) : -cutDistance;

    const distTolerance = 1e-4;
    for (const { edge, d } of dists) {
      if (Math.abs(d - startDist) < distTolerance) {
        startEdges.push(edge);
      } else if (Math.abs(d - endDist) < distTolerance) {
        endEdges.push(edge);
      } else {
        internalEdges.push(edge);
      }
    }
  }

  target.setState('section-edges', sectionEdges);
  target.setState('start-edges', startEdges);
  target.setState('end-edges', endEdges);
  target.setState('internal-edges', internalEdges);
  target.setState('internal-faces', internalFaces);
}
