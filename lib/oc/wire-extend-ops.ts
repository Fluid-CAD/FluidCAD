import type { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { EdgeOps } from "./edge-ops.js";
import { Explorer } from "./explorer.js";
import { WireOps } from "./wire-ops.js";
import { PathSampler } from "./path-sampler.js";

export type WireEnd = "start" | "end";

export class WireExtendOps {
  /**
   * Extends an open wire beyond one end by `length`, continuing straight along
   * the wire's true tangent there. The new straight edge joins the existing
   * first/last vertex, so the result is a single connected wire.
   *
   * No-op for closed wires, empty wires, or `length <= 0`.
   */
  static extendWire(wire: Wire, side: WireEnd, length: number): Wire {
    if (length <= 0) {
      return wire;
    }

    // Fresh wrappers (not `wire.getEdges()`, which caches them on a wire the
    // caller may dispose): the new wire keeps the edges, so the wrappers and
    // the line edge made here are scratch once it is built.
    const edges = Explorer.findEdgesInWireOrderWrapped(wire);
    const scratch: Shape[] = [...edges];
    try {
      if (edges.length === 0) {
        return wire;
      }

      const sampler = new PathSampler(wire);
      try {
        if (sampler.closed) {
          return wire;
        }

        if (side === "start") {
          // Tangent at the start points into the wire; extend the opposite way.
          const startVertex = edges[0].getFirstVertex();
          scratch.push(startVertex);
          const startPt = startVertex.toPoint();
          const inward = sampler.evalAt(0).tangent;
          const extPt = startPt.add(inward.multiply(-length));
          const lead = EdgeOps.makeLineEdge(extPt, startPt);
          scratch.push(lead);
          return WireOps.makeWireFromEdges([lead, ...edges]);
        }

        // Tangent at the end already points out of the wire.
        const endVertex = edges[edges.length - 1].getLastVertex();
        scratch.push(endVertex);
        const endPt = endVertex.toPoint();
        const outward = sampler.evalAt(sampler.length).tangent;
        const extPt = endPt.add(outward.multiply(length));
        const tail = EdgeOps.makeLineEdge(endPt, extPt);
        scratch.push(tail);
        return WireOps.makeWireFromEdges([...edges, tail]);
      } finally {
        sampler.dispose();
      }
    } finally {
      scratch.forEach(shape => shape.dispose());
    }
  }
}
