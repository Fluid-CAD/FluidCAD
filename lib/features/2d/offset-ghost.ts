import { Edge } from "../../common/edge.js";
import { Shape } from "../../common/shape.js";
import { Wire } from "../../common/wire.js";
import { Plane } from "../../math/plane.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { offsetConnectTolerance } from "./offset.js";

/** The dialog values a ghost offset is built from, resolved to plain values. */
export type OffsetGhostOptions = {
  /** Signed offset distance — the kernel's own side convention. */
  distance: number;
  /** `.close()` — cap an open offset back onto its source with two straight edges. */
  close: boolean;
};

export type OffsetGhostSolids = {
  /** The curves to mesh — the offset wires, plus the closing cap edges. */
  solids: Shape[];
  /** Everything built on the way there; dispose it alongside `solids`. */
  scratch: Shape[];
};

/**
 * Build the ghost curves for a 2D `offset()`: the wires the statement would
 * add, from the target edges alone — no scene reads, no shape registration.
 * The chaining mirrors `Offset.build` exactly (same tolerance, same grouping)
 * so the ghost follows the sides and fragments the apply will produce;
 * everything scene-bound is left out — `removeOriginal`, provenance,
 * start/end state.
 *
 * The caller owns disposal: every returned shape, `scratch` included, must be
 * `dispose()`d once meshed. A throw out of the offset maker (a distance the
 * profile can't take, mid-typing values) frees everything first — the caller
 * treats it as "nothing to draw".
 */
export function buildOffsetGhostWires(
  edges: Edge[],
  plane: Plane,
  options: OffsetGhostOptions,
): OffsetGhostSolids {
  const solids: Shape[] = [];
  const scratch: Shape[] = [];
  try {
    const tolerance = offsetConnectTolerance(edges);
    const wires: Wire[] = [];
    for (const group of WireOps.groupConnectedEdges(edges, tolerance)) {
      wires.push(...WireOps.makeChainWires(group, tolerance));
    }
    scratch.push(...wires);

    for (const wire of wires) {
      const offsetWire = WireOps.offsetWireOnPlane(wire, options.distance, wire.isClosed(), plane);
      solids.push(offsetWire);

      if (options.close && !offsetWire.isClosed()) {
        // The two straight caps `Offset.build` draws: original end → offset
        // end, offset start → original start. The vertex wrappers are
        // build-time temporaries and go back with the scratch.
        const ends = [
          wire.getFirstVertex(), wire.getLastVertex(),
          offsetWire.getFirstVertex(), offsetWire.getLastVertex(),
        ];
        scratch.push(...ends);
        const [originalStart, originalEnd, offsetStart, offsetEnd] = ends.map(v => v.toPoint());
        solids.push(EdgeOps.makeLineEdge(originalEnd, offsetEnd));
        solids.push(EdgeOps.makeLineEdge(offsetStart, originalStart));
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
