import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import plane from "../../../core/plane.js";
import { arc, circle, line, project } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Edge } from "../../../common/edge.js";
import { Point } from "../../../math/point.js";
import { Vector3d } from "../../../math/vector3d.js";
import { getOC } from "../../../oc/index.js";
import { edgeOnCircleSegment } from "../../../oc/projection/edge-on-circle.js";

interface Described {
  type: 'line' | 'circle' | 'other';
  start: Point;
  end: Point;
}

function describeEdges(shapes: unknown[]): Described[] {
  const oc = getOC();
  const out: Described[] = [];
  for (const shape of shapes) {
    if (!(shape instanceof Edge)) {
      continue;
    }
    const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
    const curveType = adaptor.GetType();
    adaptor.delete();
    const type = curveType === oc.GeomAbs_CurveType.GeomAbs_Line ? 'line'
      : curveType === oc.GeomAbs_CurveType.GeomAbs_Circle ? 'circle' : 'other';
    out.push({ type, start: shape.getFirstVertex().toPoint(), end: shape.getLastVertex().toPoint() });
  }
  return out;
}

/** A line whose two ends match the given points in either order. */
function hasLine(edges: Described[], a: [number, number, number], b: [number, number, number]): boolean {
  const pa = new Point(...a);
  const pb = new Point(...b);
  return edges.some(e => e.type === 'line'
    && ((e.start.distanceTo(pa) < 1e-4 && e.end.distanceTo(pb) < 1e-4)
      || (e.start.distanceTo(pb) < 1e-4 && e.end.distanceTo(pa) < 1e-4)));
}

describe("edge-on circle fold segment (pure math)", () => {
  const unitCircle = {
    center: new Point(0, 0, 0),
    axis: new Vector3d(0, 0, 1),
    xDir: new Vector3d(1, 0, 0),
    radius: 10,
  };

  it("folds a full circle to its diameter perpendicular to the view", () => {
    const seg = edgeOnCircleSegment({ ...unitCircle, first: 0, last: 2 * Math.PI }, new Vector3d(0, 1, 0))!;
    expect(seg).not.toBeNull();
    const xs = [seg.start.x, seg.end.x].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10, 9);
    expect(xs[1]).toBeCloseTo(10, 9);
    expect(seg.start.y).toBeCloseTo(0, 9);
    expect(seg.end.y).toBeCloseTo(0, 9);
  });

  it("covers only the arc's own extent, including an interior extremum", () => {
    // Quarter arc 0..90°: reaches x = 10 at its start, x = 0 at its end.
    const quarter = edgeOnCircleSegment({ ...unitCircle, first: 0, last: Math.PI / 2 }, new Vector3d(0, 1, 0))!;
    const qx = [quarter.start.x, quarter.end.x].sort((a, b) => a - b);
    expect(qx[0]).toBeCloseTo(0, 9);
    expect(qx[1]).toBeCloseTo(10, 9);

    // Arc 45°..135° straddles the +y extremum, which is along the view and
    // does not widen the fold; its x extent is ±10·cos45°.
    const top = edgeOnCircleSegment({ ...unitCircle, first: Math.PI / 4, last: 3 * Math.PI / 4 }, new Vector3d(0, 1, 0))!;
    const tx = [top.start.x, top.end.x].sort((a, b) => a - b);
    expect(tx[0]).toBeCloseTo(-10 * Math.SQRT1_2, 9);
    expect(tx[1]).toBeCloseTo(10 * Math.SQRT1_2, 9);

    // Arc -135°..-45° straddles the -x... no: the -y extremum; same width.
    // Arc 135°..225° straddles the -x extremum: reaches x = -10 inside.
    const left = edgeOnCircleSegment({ ...unitCircle, first: 3 * Math.PI / 4, last: 5 * Math.PI / 4 }, new Vector3d(0, 1, 0))!;
    const lx = [left.start.x, left.end.x].sort((a, b) => a - b);
    expect(lx[0]).toBeCloseTo(-10, 9);
    expect(lx[1]).toBeCloseTo(-10 * Math.SQRT1_2, 9);
  });

  it("is not edge-on when the view has a component along the circle normal", () => {
    expect(edgeOnCircleSegment({ ...unitCircle, first: 0, last: 2 * Math.PI }, new Vector3d(0, 0, 1))).toBeNull();
    expect(edgeOnCircleSegment({ ...unitCircle, first: 0, last: 2 * Math.PI }, new Vector3d(0, 1, 0.01))).toBeNull();
  });
});

describe("projecting cylinders onto a plane through their axis", () => {
  setupOC();

  it("projects an edge-on circle as one line across its diameter", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(30) as Extrude;
    const s = sketch("xz", () => {
      project(e.startEdges());
    }) as Sketch;
    render();

    const edges = describeEdges(s.getShapes());
    expect(edges.length).toBe(1);
    expect(hasLine(edges, [-10, 0, 0], [10, 0, 0])).toBe(true);
  });

  it("projects a cylinder side face seen from the side as a rectangle, without its seam", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(30) as Extrude;
    const s = sketch("xz", () => {
      project(e.sideFaces(0));
    }) as Sketch;
    render();

    const edges = describeEdges(s.getShapes());
    expect(edges.map(e => e.type)).toEqual(['line', 'line', 'line', 'line']);
    // Two outline generatrices …
    expect(hasLine(edges, [-10, 0, 0], [-10, 0, 30])).toBe(true);
    expect(hasLine(edges, [10, 0, 0], [10, 0, 30])).toBe(true);
    // … and the two edge-on end circles.
    expect(hasLine(edges, [-10, 0, 0], [10, 0, 0])).toBe(true);
    expect(hasLine(edges, [-10, 0, 30], [10, 0, 30])).toBe(true);
  });

  it("projects a cylinder side face seen along its axis as one circle only", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(30) as Extrude;
    const s = sketch("xy", () => {
      project(e.sideFaces(0));
    }) as Sketch;
    render();

    const edges = describeEdges(s.getShapes());
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe('circle');
  });

  it("emits an outline only where the partial cylinder actually turns past the view", () => {
    // A 90° sector from -45° to +45°: seen along y its cylindrical face
    // turns past the view at 0°, inside the face — one outline generatrix at
    // x = 10. Its edge-on arcs fold to short lines from x = 10·cos45° to 10.
    const c = 10 * Math.SQRT1_2;
    sketch("xy", () => {
      line([0, 0], [c, -c]);
      arc([c, -c], [c, c], [0, 0]);
      line([c, c], [0, 0]);
    });
    const e = extrude(30) as Extrude;
    const s = sketch("xz", () => {
      project(e.sideFaces());
    }) as Sketch;
    render();

    const edges = describeEdges(s.getShapes());
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.type).toBe('line');
      expect(Math.max(edge.start.x, edge.end.x)).toBeLessThan(10 + 1e-4);
    }
    expect(hasLine(edges, [10, 0, 0], [10, 0, 30])).toBe(true);
    expect(hasLine(edges, [c, 0, 0], [10, 0, 0])).toBe(true);
    expect(hasLine(edges, [c, 0, 30], [10, 0, 30])).toBe(true);
  });

  it("projects an arc parallel to the plane as an exact arc, not a B-spline fit", () => {
    // A half-disc extruded symmetrically: its start-face arc lies in a plane
    // parallel to the offset sketch plane. The projection must stay a true
    // circle arc with exact endpoints, or a profile drawn against it
    // micro-gaps and extrudes nothing.
    sketch("xz", () => {
      line([-20, 0], [20, 0]);
      arc([20, 0], [-20, 0], [0, 0]);
    });
    const e = extrude(40).symmetric() as Extrude;
    const s = sketch(plane("xz", 30), () => {
      project(e.startEdges());
    }) as Sketch;
    render();

    const edges = describeEdges(s.getShapes());
    expect(edges.map(d => d.type).sort()).toEqual(['circle', 'line']);
    const arcEdge = edges.find(d => d.type === 'circle')!;
    const xs = [arcEdge.start.x, arcEdge.end.x].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-20, 9);
    expect(xs[1]).toBeCloseTo(20, 9);
    expect(arcEdge.start.y).toBeCloseTo(-30, 9);
    expect(hasLine(edges, [-20, -30, 0], [20, -30, 0])).toBe(true);
  });
});
