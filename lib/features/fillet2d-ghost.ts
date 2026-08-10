import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";

export type Fillet2DGhostSolids = {
  /** The curves to mesh — the new corner arcs the fillet would add. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Build the ghost curves for a 2D `fillet()`: the corner arcs the statement
 * would add, from the target edges alone — no scene reads, no shape
 * registration. Only the arcs are drawn: the trimmed survivors lie on the
 * sketch's own lines, so ghosting them would just repaint the profile, while
 * the arcs are the change — the same call the 3D fillet's ghost makes by
 * showing its band, not its whole result.
 *
 * The wiring mirrors `Fillet2D.build` exactly — same grouping, same wire
 * maker, same `FilletOps.fillet2d` — and so does the classification: a result
 * edge no input edge accounts for (`findRoleSource`) whose curve is a circle
 * is a fillet arc. A corner the radius can't take is skipped by the maker,
 * so it contributes no arc and the rest still draw — exactly what the apply
 * will do.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. A throw out of the fillet maker frees everything
 * first — the caller treats it as "nothing to draw".
 */
export function buildFillet2DGhostArcs(
  edges: Edge[],
  plane: Plane,
  radius: number,
): Fillet2DGhostSolids {
  const solids: Shape[] = [];
  const scratch: Shape[] = [];
  try {
    const tolerance = WireOps.connectTolerance(edges);
    for (const group of WireOps.groupConnectedEdges(edges, tolerance)) {
      for (const wire of WireOps.makeChainWires(group, tolerance)) {
        scratch.push(wire);
        const filleted = FilletOps.fillet2d(wire, plane, radius);
        scratch.push(filleted);
        for (const edge of filleted.getEdges()) {
          const isArc = GeometrySceneObject.findRoleSource(edge, group) === null
            && EdgeQuery.getEdgeCurveType(edge) === 'circle';
          (isArc ? solids : scratch).push(edge);
        }
      }
    }
    return { solids, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing.
    for (const shape of [...solids, ...scratch]) {
      shape.dispose();
    }
    throw err;
  }
}
