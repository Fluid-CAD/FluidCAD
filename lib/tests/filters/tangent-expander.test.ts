import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { TangentExpander } from "../../filters/tangent-expander.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { TestCurves } from "../helpers/curves.js";

/** A line from the origin to (10, 0), then an arc leaving (10, 0) along `tangent` to `end`. */
function lineThenArc(tangent: Vector3d, end: Point): Wire {
  const arc = Geometry.makeArcFromTangent(new Point(10, 0, 0), end, tangent);
  let arcEdge: Edge;
  try {
    arcEdge = Geometry.makeEdgeFromCurve(arc);
  } finally {
    arc.delete();
  }
  const edges = [EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0)), arcEdge];
  try {
    return WireOps.makeWireFromEdges(edges);
  } finally {
    for (const edge of edges) edge.dispose();
  }
}

/** The arc's mirror image as a cusp: it leaves (10, 0) back along -x, folding onto the line's side. */
const cusp = () => lineThenArc(new Vector3d(-1, 0, 0), new Point(5, 5, 0));

describe("TangentExpander", () => {
  setupOC();

  it("follows a line into the arc it runs into tangentially", () => {
    const wire = TestCurves.lineIntoArc();
    try {
      const edges = wire.getEdges();
      expect(TangentExpander.expand([edges[0]], edges)).toHaveLength(2);
      expect(TangentExpander.expand([edges[1]], edges)).toHaveLength(2);
      expect(TangentExpander.areEdgesTangent(edges[0], edges[1])).toBe(true);
    } finally {
      wire.dispose();
    }
  });

  it("stops at a corner", () => {
    const wire = TestCurves.lineIntoArcThenCorner();
    try {
      const edges = wire.getEdges();
      expect(TangentExpander.expand([edges[0]], edges)).toHaveLength(2);
      expect(TangentExpander.expand([edges[2]], edges)).toHaveLength(1);
    } finally {
      wire.dispose();
    }
  });

  it("does not take a cusp, where the next edge folds straight back, as tangent", () => {
    const wire = cusp();
    try {
      const edges = wire.getEdges();
      expect(edges).toHaveLength(2);
      expect(TangentExpander.areEdgesTangent(edges[0], edges[1])).toBe(false);
      expect(TangentExpander.expand([edges[0]], edges)).toHaveLength(1);
      expect(TangentExpander.expand([edges[1]], edges)).toHaveLength(1);
    } finally {
      wire.dispose();
    }
  });

  it("reads a smooth continuation and a cusp the same whichever way an edge is oriented", () => {
    for (const [build, tangent] of [[TestCurves.lineIntoArc, true], [cusp, false]] as const) {
      const wire = build();
      try {
        const [line, arc] = wire.getEdges();
        const flipped = line.getShape().Reversed();
        const reversed = Edge.fromTopoDSEdge(getOC().TopoDS.Edge(flipped));
        flipped.delete();
        try {
          expect(TangentExpander.areEdgesTangent(reversed, arc)).toBe(tangent);
          expect(TangentExpander.areEdgesTangent(arc, reversed)).toBe(tangent);
        } finally {
          reversed.dispose();
        }
      } finally {
        wire.dispose();
      }
    }
  });
});
