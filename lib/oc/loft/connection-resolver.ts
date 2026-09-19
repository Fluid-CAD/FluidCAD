import { Wire } from "../../common/wire.js";
import { Point } from "../../math/point.js";
import { mmTol } from "../../units/tolerance.js";
import { getActiveUnit } from "../../units/registry.js";
import { EdgeOps } from "../edge-ops.js";
import { getOC } from "../init.js";
import { SectionCurve } from "./section-curve.js";
import { SectionPins } from "./section-pins.js";

/** World points become wire vertex indices here; no curve parameter search. */
export class ConnectionResolver {
  static resolve(wires: Wire[], connections: Point[][]): SectionPins {
    if (wires.length < 2) {
      throw new Error("Loft requires at least two profiles.");
    }
    for (const [i, connection] of connections.entries()) {
      if (connection.length !== wires.length) {
        throw new Error(`Loft connection ${i + 1}: connect expects ${wires.length} points, one per profile, got ${connection.length}.`);
      }
    }

    const oc = getOC();
    const tolerance = mmTol(1e-3);
    const vertexIndices = wires.map((wire, k) => {
      if (!wire.isClosed()) {
        throw new Error(`Loft connections require closed profiles; profile ${k + 1} is open.`);
      }
      const finder = new oc.BRepBuilderAPI_FindPlane(wire.getShape(), mmTol(1e-6));
      try {
        if (!finder.Found()) {
          throw new Error(`Loft connections require planar profiles; profile ${k + 1} is not planar.`);
        }
      } finally {
        finder.delete();
      }

      const edges = wire.getEdges().filter(edge => !oc.BRep_Tool.Degenerated(edge.getShape()));
      // The section pipeline's own vertex walk: pins are indices into it.
      const candidates = SectionCurve.wireVertices(wire.getShape());
      const used = new Map<number, number>();
      return connections.map((connection, i) => {
        const point = connection[k];
        const context = `Loft connection ${i + 1}: the point for profile ${k + 1}`;
        if (!point || !point.toArray().every(Number.isFinite)) {
          throw new Error(`${context} must have finite coordinates.`);
        }
        let nearest = -1;
        let gap = Infinity;
        for (const [index, candidate] of candidates.entries()) {
          const distance = candidate.distanceTo(point);
          if (distance < gap) {
            gap = distance;
            nearest = index;
          }
        }
        if (gap > tolerance) {
          const profileGap = Math.min(...edges.map(edge => EdgeOps.distancePointToEdge(point, edge)));
          if (profileGap <= tolerance) {
            throw new Error(`${context} lies on an edge, not on a vertex — connections join profile vertices. Split smooth closed curves into arcs to create vertices.`);
          }
          throw new Error(`${context} is off its profile (gap ${profileGap.toPrecision(6)} ${getActiveUnit()}).`);
        }
        const previous = used.get(nearest);
        if (previous !== undefined) {
          throw new Error(`Loft connections ${previous + 1} and ${i + 1} use the same vertex on profile ${k + 1}.`);
        }
        used.set(nearest, i);
        return nearest;
      });
    });
    return new SectionPins(vertexIndices);
  }
}
