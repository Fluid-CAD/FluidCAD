import { Edge } from "../../common/edge.js";
import { GeometrySceneObject } from "./geometry.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Geometry } from "../../oc/geometry.js";

export type ConnectMode = 'line' | 'arc';

export class Connect extends GeometrySceneObject {

  constructor(private mode: ConnectMode = 'line') {
    super();
  }

  build() {
    const siblings = this.sketch.getPreviousSiblings(this);

    const edges: Edge[] = [];
    for (const obj of siblings) {
      const shapes = obj.getShapes().filter(s => s instanceof Edge) as Edge[];
      for (const edge of shapes) {
        if (EdgeQuery.isEdgeClosedCurve(edge)) {
          continue;
        }

        edges.push(edge);
        obj.removeShape(edge, this);
      }
    }

    // Unify edge orientations to match the first edge's winding direction.
    const normal = this.sketch.getPlane().normal;

    const windingSigns: number[] = [];
    for (const edge of edges) {
      const start = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge));
      const end = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge));
      const mid = EdgeOps.getEdgeMidPoint(edge);

      const toMid = start.vectorTo(mid);
      const toEnd = start.vectorTo(end);
      windingSigns.push(toMid.cross(toEnd).dot(normal));
    }

    // Reverse edges whose winding doesn't match the first edge.
    const refSign = windingSigns[0];
    for (let i = 1; i < edges.length; i++) {
      if ((windingSigns[i] > 0) !== (refSign > 0)) {
        edges[i] = EdgeOps.reverseEdge(edges[i]);
      }
    }

    const useArc = this.mode === 'arc';

    const makeBridgeEdge = (curve: any, v1: any, v2: any): Edge => {
      return EdgeOps.makeEdgeFromCurveAndVertices(curve, v1, v2);
    };

    const makeBridge = (edge1: Edge, edge2: Edge): Edge => {
      const v1 = EdgeOps.getLastVertex(edge1);
      const v2 = EdgeOps.getFirstVertex(edge2);

      const startPt = EdgeOps.getVertexPoint(v1);
      const endPt = EdgeOps.getVertexPoint(v2);

      if (useArc) {
        const edgeTangent = EdgeOps.getEdgeTangentAtEnd(edge1);
        const bridgeDir = startPt.vectorTo(endPt);

        // If tangent is nearly collinear with the bridge direction, an arc
        // degenerates into a semicircle. Fall back to a straight line.
        if (edgeTangent.isParallelTo(bridgeDir)) {
          return makeBridgeEdge(Geometry.makeSegment(startPt, endPt), v1, v2);
        }

        // Negate tangent only if it points away from the endpoint (would create looping arc).
        const tangent = edgeTangent.dot(bridgeDir) < 0 ? edgeTangent.negate() : edgeTangent;
        return makeBridgeEdge(Geometry.makeArcFromTangent(startPt, endPt, tangent), v1, v2);
      } else {
        return makeBridgeEdge(Geometry.makeSegment(startPt, endPt), v1, v2);
      }
    };

    // Build wire: edge[0], bridge, edge[1], bridge, edge[2], ..., closing bridge
    const wireEdges: Edge[] = [];
    wireEdges.push(edges[0]);

    for (let i = 1; i < edges.length; i++) {
      wireEdges.push(makeBridge(edges[i - 1], edges[i]));
      wireEdges.push(edges[i]);
    }

    // Close the loop: bridge from last edge back to first
    wireEdges.push(makeBridge(edges[edges.length - 1], edges[0]));

    let wire = WireOps.buildWire(wireEdges);

    // Ensure the wire is CCW relative to the sketch plane normal.
    if (wire.isCW(this.sketch.getPlane().normal)) {
      wire = WireOps.reverseWire(wire);
    }
    this.addShape(wire);
  }

  compareTo(other: Connect): boolean {
    if (!(other instanceof Connect)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.mode === other.mode;
  }

  getType(): string {
    return 'connect'
  }

  serialize() {
    return {
      mode: this.mode
    }
  }
}
