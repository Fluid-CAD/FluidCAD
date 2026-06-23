import { Wire } from "../common/wire.js";
import { EdgeOps } from "./edge-ops.js";
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

    const edges = wire.getEdges();
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
        const startPt = wire.getFirstVertex().toPoint();
        const inward = sampler.evalAt(0).tangent;
        const extPt = startPt.add(inward.multiply(-length));
        return WireOps.makeWireFromEdges([EdgeOps.makeLineEdge(extPt, startPt), ...edges]);
      }

      // Tangent at the end already points out of the wire.
      const endPt = wire.getLastVertex().toPoint();
      const outward = sampler.evalAt(sampler.length).tangent;
      const extPt = endPt.add(outward.multiply(length));
      return WireOps.makeWireFromEdges([...edges, EdgeOps.makeLineEdge(endPt, extPt)]);
    } finally {
      sampler.dispose();
    }
  }
}
