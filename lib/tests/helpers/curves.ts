import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

/**
 * Curves built straight from the kernel, for tests that need a standalone
 * wire before any feature leaves one in the scene. Each call returns a new
 * wire the test owns and must dispose; the edges it was built from are freed
 * here.
 */
export const TestCurves = {
  /**
   * Three edges on the XY plane: a line from the origin to (10, 0), an arc
   * through (15, 5) to (20, 0), and a line down to (20, -10).
   */
  threeEdges(): Wire {
    const arc = Geometry.makeArcThreePoints(new Point(10, 0, 0), new Point(15, 5, 0), new Point(20, 0, 0));
    let arcEdge: Edge;
    try {
      arcEdge = Geometry.makeEdgeFromCurve(arc);
    } finally {
      arc.delete();
    }
    return wireOf([
      EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0)),
      arcEdge,
      EdgeOps.makeLineEdge(new Point(20, 0, 0), new Point(20, -10, 0)),
    ]);
  },

  /** A line from the origin to (10, 0) running tangentially into a quarter arc of radius 10 that ends at (20, 10). */
  lineIntoArc(): Wire {
    const arc = Geometry.makeArcFromTangent(new Point(10, 0, 0), new Point(20, 10, 0), new Vector3d(1, 0, 0));
    let arcEdge: Edge;
    try {
      arcEdge = Geometry.makeEdgeFromCurve(arc);
    } finally {
      arc.delete();
    }
    return wireOf([EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0)), arcEdge]);
  },

  /** {@link lineIntoArc} followed by a line from (20, 10) to (30, 10): a corner, so the tangent chain stops at the arc. */
  lineIntoArcThenCorner(): Wire {
    const arc = Geometry.makeArcFromTangent(new Point(10, 0, 0), new Point(20, 10, 0), new Vector3d(1, 0, 0));
    let arcEdge: Edge;
    try {
      arcEdge = Geometry.makeEdgeFromCurve(arc);
    } finally {
      arc.delete();
    }
    return wireOf([
      EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0)),
      arcEdge,
      EdgeOps.makeLineEdge(new Point(20, 10, 0), new Point(30, 10, 0)),
    ]);
  },
};

function wireOf(edges: Edge[]): Wire {
  try {
    return WireOps.makeWireFromEdges(edges);
  } finally {
    for (const edge of edges) edge.dispose();
  }
}
