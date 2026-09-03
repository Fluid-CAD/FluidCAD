import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { mmTol } from "../units/tolerance.js";

/**
 * Store a cut's classification state on `target`.
 *
 * Section edges are the cleaned result's edges not geometrically present in
 * the stock (compared by midpoint) — that deliberately includes stock edges
 * the cut trimmed, so a notched rim edge still resolves to `c.startEdges(k)`
 * rather than to nothing. They are further classified by signed distance
 * from the cut plane into start, end, and internal groups.
 *
 * Internal faces are NOT derived from those edges: a stock face the tool only
 * trims (a bottom rim split by a cut whose profile edge lies on that bottom)
 * keeps none of its original edges, so an edge-based rule would misfile it as
 * cut-created. `internalFaces` is the kernel's answer instead — every result
 * face that is neither a stock face nor the boolean's `Modified()` image of
 * one (see `BooleanOps.cutMultiShape`), remapped through the cleanup lineage.
 *
 * Sets state keys on target: section-edges, start-edges, end-edges,
 * internal-edges, internal-faces
 */
export function classifyCutResult(
  target: SceneObject,
  stockShapes: Shape[],
  cleanedShapes: Shape[],
  internalFaces: Face[],
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

  const tolerance = mmTol(1e-6);
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

    const distTolerance = mmTol(1e-4);
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
