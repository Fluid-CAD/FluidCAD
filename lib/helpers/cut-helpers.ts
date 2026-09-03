import { SceneObject } from "../common/scene-object.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Plane } from "../math/plane.js";
import { mmTol } from "../units/tolerance.js";

/**
 * Store a cut's classification state on `target` from the geometry the cut
 * CREATED: `sectionEdges` and `internalFaces` are the result edges/faces that
 * are neither stock sub-shapes nor the boolean's `Modified()` images of one
 * (see `BooleanOps.cutMultiShape`), already remapped through the post-cut
 * cleanup lineage.
 *
 * Kernel history is the only sound source here. Comparing result geometry
 * against the stock misfiles whatever the tool merely trims: a bottom rim
 * split by a cut whose profile edge lies on that bottom keeps none of its
 * original edges, and a rim edge notched by a cut keeps neither its length
 * nor its midpoint — yet both descend from stock, exactly like a side face a
 * fillet trims, and resolve to their creator through modification lineage.
 *
 * Section edges are further classified by signed distance from the cut plane
 * into start, end, and internal groups.
 *
 * Sets state keys on target: section-edges, start-edges, end-edges,
 * internal-edges, internal-faces
 */
export function classifyCutResult(
  target: SceneObject,
  sectionEdges: Edge[],
  internalFaces: Face[],
  plane: Plane,
  cutDistance: number,
): void {
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
