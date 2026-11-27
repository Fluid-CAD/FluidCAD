import { afterEach, describe, expect, it } from "vitest";
import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { TubeOps } from "../../oc/tube-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { TopologyIndex } from "../../oc/topology-index.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Point } from "../../math/point.js";

const owned: { delete(): void }[] = [];
const wires: Wire[] = [];
afterEach(() => {
  owned.splice(0).reverse().forEach(shape => shape.delete());
  wires.splice(0).forEach(wire => wire.dispose());
});

/** A tube the test frees. */
function tube(wire: Wire, radius: number): TopoDS_Shape {
  const shape = TubeOps.around(wire, radius);
  owned.push(shape);
  return shape;
}

/** An open polyline through `points`, as one wire. */
function polyline(...points: [number, number, number][]): Wire {
  const edges = points.slice(1).map((point, i) => EdgeOps.makeLineEdge(new Point(...points[i]), new Point(...point)));
  const wire = WireOps.makeWireFromEdges(edges);
  edges.forEach(e => e.dispose());
  wires.push(wire);
  return wire;
}

/** A closed circle of `radius` round Z, as one wire. */
function ring(radius: number): Wire {
  const oc = getOC();
  const placement = new oc.gp_Ax2();
  const circle = new oc.gp_Circ(placement, radius);
  const maker = new oc.BRepBuilderAPI_MakeEdge(circle);
  const edge = Edge.fromTopoDSEdge(maker.Edge());
  try {
    const wire = WireOps.makeWireFromEdges([edge]);
    wires.push(wire);
    return wire;
  } finally {
    edge.dispose();
    maker.delete();
    circle.delete();
    placement.delete();
  }
}

function subShapes(shape: TopoDS_Shape, type: "FACE" | "EDGE" | "SHELL"): TopoDS_Shape[] {
  const oc = getOC();
  const found = Explorer.findShapes(shape, oc.TopAbs_ShapeEnum[`TopAbs_${type}`] as TopAbs_ShapeEnum);
  owned.push(...found);
  return found;
}

/**
 * The tube's open rims: edges only one of its faces bounds (a seam counts
 * its face twice), the degenerate edges at a corner face's poles left out.
 */
function rimEdges(shape: TopoDS_Shape): TopoDS_Shape[] {
  const oc = getOC();
  const index = TopologyIndex.buildEdgeToFaces(shape);
  const degenerate = (edge: TopoDS_Shape) => {
    const typed = oc.TopoDS.Edge(edge);
    try {
      return oc.BRep_Tool.Degenerated(typed);
    } finally {
      typed.delete();
    }
  };
  try {
    return subShapes(shape, "EDGE").filter(edge => index.Seek(edge)?.Size() === 1 && !degenerate(edge));
  } finally {
    index.delete();
  }
}

describe("TubeOps.around", () => {
  it("makes one cylindrical face of the radius round a straight edge, with two open rims", () => {
    const shape = tube(polyline([0, 0, 0], [10, 0, 0]), 2);

    expect(Explorer.getShapeType(shape)).toBe("Shell");
    const faces = subShapes(shape, "FACE");
    expect(faces).toHaveLength(1);
    const surface = SurfaceClassifier.classifyRaw(faces[0]);
    expect(surface.kind).toBe("cylinder");
    expect(surface.recovered).toBe(false);
    expect(surface.radius).toBeCloseTo(2, 9);
    expect(surface.axis!.direction.cross(surface.axis!.origin.vectorTo(new Point(10, 0, 0))).length()).toBeLessThan(1e-9);

    const rims = rimEdges(shape);
    expect(rims).toHaveLength(2);
    const centres = rims.map(edge => {
      const typed = getOC().TopoDS.Edge(edge);
      try {
        return EdgeOps.getEdgeMidPointRaw(typed).x;
      } finally {
        typed.delete();
      }
    }).sort((a, b) => a - b);
    expect(centres[0]).toBeCloseTo(0, 9);
    expect(centres[1]).toBeCloseTo(10, 9);
  });

  it("makes one connected shell round an L-shaped wire: a cylinder per leg and the corner turned round it", () => {
    const shape = tube(polyline([0, 0, 0], [10, 0, 0], [10, 10, 0]), 2);

    expect(Explorer.getShapeType(shape)).toBe("Shell");
    const kinds = subShapes(shape, "FACE").map(face => SurfaceClassifier.classifyRaw(face).kind).sort();
    expect(kinds).toEqual(["cylinder", "cylinder", "sphere"]);
    // One shell whose only open rims are the two end circles: the three
    // faces join along their shared edges (apart they would leave six).
    expect(subShapes(shape, "SHELL")).toHaveLength(1);
    expect(rimEdges(shape)).toHaveLength(2);
  });

  it("makes a torus wall round a closed circle, with no open rim", () => {
    const shape = tube(ring(10), 2);

    const faces = subShapes(shape, "FACE");
    expect(faces).toHaveLength(1);
    const surface = SurfaceClassifier.classifyRaw(faces[0]);
    expect(surface.kind).toBe("torus");
    expect(surface.majorRadius).toBeCloseTo(10, 9);
    expect(surface.minorRadius).toBeCloseTo(2, 9);
    expect(rimEdges(shape)).toHaveLength(0);
  });

  it("refuses a radius that is not positive", () => {
    expect(() => TubeOps.around(polyline([0, 0, 0], [10, 0, 0]), 0)).toThrow(/radius must be positive/);
  });
});
