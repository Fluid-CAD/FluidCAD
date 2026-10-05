import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import { arc } from "../core/2d/index.js";
import { SketchEntitySplit, SplitRefusal } from "../features/2d/split.js";
import { Point2D } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { fitArcThroughEndpoints } from "../features/2d/arc-fit.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import type { Edge } from "../common/edge.js";

// The sketch Split tool's kernel side: the click projects onto the entity and
// the pieces come back from the OCC edges built for them.

setupOC();

const near = (a: [number, number], b: [number, number], tol = 1e-6): void => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tol);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tol);
};

describe("SketchEntitySplit.split", () => {
  it("cuts a line at the projection of the click", () => {
    const outcome = SketchEntitySplit.split({ kind: "line", start: [0, 0], end: [40, 0] }, [10, 3]);
    near(outcome.at, [10, 0]);
    expect(outcome.pieces).toHaveLength(2);
    const [first, second] = outcome.pieces;
    if (first.kind !== "line" || second.kind !== "line") {
      throw new Error("expected lines");
    }
    near(first.start, [0, 0]);
    near(first.end, [10, 0]);
    near(second.start, [10, 0]);
    near(second.end, [40, 0]);
  });

  it("cuts a counter-clockwise arc into two arcs around the same center", () => {
    // Quarter arc from (10,0) to (0,10) around the origin, split near 45°.
    const outcome = SketchEntitySplit.split(
      { kind: "arc", start: [10, 0], end: [0, 10], center: [0, 0], cw: false },
      [8, 8],
    );
    const r = Math.SQRT1_2 * 10;
    near(outcome.at, [r, r]);
    const [first, second] = outcome.pieces;
    expect(first.kind).toBe("arc");
    expect(second.kind).toBe("arc");
    if (first.kind !== "arc" || second.kind !== "arc") {
      return;
    }
    near(first.start, [10, 0]);
    near(first.end, [r, r]);
    near(second.start, [r, r]);
    near(second.end, [0, 10]);
    near(first.center, [0, 0]);
    expect(first.cw).toBe(false);
    expect(second.cw).toBe(false);
  });

  it("keeps the drawn sweep side of a clockwise arc", () => {
    // Clockwise from (10,0) to (0,10) is the long way round (270°); a click
    // at the bottom lands on the arc, not on the short quarter.
    const outcome = SketchEntitySplit.split(
      { kind: "arc", start: [10, 0], end: [0, 10], center: [0, 0], cw: true },
      [0, -9],
    );
    near(outcome.at, [0, -10]);
    const [first, second] = outcome.pieces;
    if (first.kind !== "arc" || second.kind !== "arc") {
      throw new Error("expected arcs");
    }
    expect(first.cw).toBe(true);
    near(first.start, [10, 0]);
    near(first.end, [0, -10]);
    near(second.start, [0, -10]);
    near(second.end, [0, 10]);
  });

  it("turns a circle into one full-turn arc starting at the split point", () => {
    const outcome = SketchEntitySplit.split({ kind: "circle", center: [5, 5], radius: 10 }, [5, 20]);
    near(outcome.at, [5, 15]);
    expect(outcome.pieces).toHaveLength(1);
    const piece = outcome.pieces[0];
    if (piece.kind !== "arc") {
      throw new Error("expected an arc");
    }
    near(piece.start, [5, 15]);
    near(piece.end, [5, 15]);
    near(piece.center, [5, 5]);
  });

  it("refuses a cut at an end", () => {
    expect(() => SketchEntitySplit.split({ kind: "line", start: [0, 0], end: [40, 0] }, [40.001, 1]))
      .toThrow(SplitRefusal);
    expect(() => SketchEntitySplit.split({ kind: "line", start: [0, 0], end: [40, 0] }, [-5, 0]))
      .toThrow(SplitRefusal);
  });

  it("reports which piece a point touches", () => {
    const { pieces } = SketchEntitySplit.split({ kind: "line", start: [0, 0], end: [40, 0] }, [10, 0]);
    expect(SketchEntitySplit.nearestPiece(pieces, [3, 1])).toBe(0);
    expect(SketchEntitySplit.nearestPiece(pieces, [30, -1])).toBe(1);
  });
});

describe("SketchEntitySplit.cut", () => {
  it("cuts a line at several points in travel order, whatever order they come in", () => {
    const pieces = SketchEntitySplit.cut({ kind: "line", start: [0, 0], end: [40, 0] }, [[30, 2], [10, -1]]);
    expect(pieces.map(p => p.kind)).toEqual(["line", "line", "line"]);
    const [a, b, c] = pieces as Extract<typeof pieces[number], { kind: "line" }>[];
    near(a.start, [0, 0]);
    near(a.end, [10, 0]);
    near(b.start, [10, 0]);
    near(b.end, [30, 0]);
    near(c.start, [30, 0]);
    near(c.end, [40, 0]);
  });

  it("leaves an entity cut nowhere as its one piece", () => {
    const line = SketchEntitySplit.cut({ kind: "line", start: [0, 0], end: [40, 0] }, []);
    expect(line).toHaveLength(1);
    expect(line[0].kind).toBe("line");
    const circle = SketchEntitySplit.cut({ kind: "circle", center: [5, 5], radius: 10 }, []);
    expect(circle).toEqual([{ kind: "circle", center: [5, 5], radius: 10 }]);
  });

  it("cuts a clockwise arc along its sweep", () => {
    // Clockwise from (10,0) to (0,10) is the long way round through the
    // bottom: the cuts at the bottom and at the left come in that order.
    const pieces = SketchEntitySplit.cut(
      { kind: "arc", start: [10, 0], end: [0, 10], center: [0, 0], cw: true },
      [[-9, 0], [0, -9]],
    );
    expect(pieces).toHaveLength(3);
    const [a, b, c] = pieces as Extract<typeof pieces[number], { kind: "arc" }>[];
    near(a.start, [10, 0]);
    near(a.end, [0, -10]);
    near(b.start, [0, -10]);
    near(b.end, [-10, 0]);
    near(c.start, [-10, 0]);
    near(c.end, [0, 10]);
    expect(pieces.every(p => p.kind === "arc" && p.cw)).toBe(true);
  });

  it("cuts a circle into arcs running counter-clockwise from the first cut", () => {
    const pieces = SketchEntitySplit.cut({ kind: "circle", center: [0, 0], radius: 10 }, [[0, 10], [10, 0]]);
    expect(pieces).toHaveLength(2);
    const [a, b] = pieces as Extract<typeof pieces[number], { kind: "arc" }>[];
    near(a.start, [0, 10]);
    near(a.end, [10, 0]);
    near(b.start, [10, 0]);
    near(b.end, [0, 10]);
    expect(a.cw).toBe(false);
    expect(b.cw).toBe(false);
  });

  it("refuses two cuts on top of each other", () => {
    expect(() => SketchEntitySplit.cut({ kind: "line", start: [0, 0], end: [40, 0] }, [[10, 0], [10.001, 0]]))
      .toThrow(/coincide/);
  });
});

describe("full-turn arc", () => {
  const xy = new Plane(new Point(0, 0, 0), new Vector3d(1, 0, 0), new Vector3d(0, 0, 1));

  it("fits coincident ends as a circle whose seam sits at the authored end", () => {
    const fitted = fitArcThroughEndpoints(xy, new Point2D(10, 0), new Point2D(10, 0), new Point2D(0, 0), false);
    expect(fitted.actualCenter.x).toBeCloseTo(0);
    expect(fitted.actualCenter.y).toBeCloseTo(0);
    expect(EdgeQuery.isEdgeClosedCurve(fitted.edge)).toBe(true);
    expect(EdgeOps.getEdgeLengthRaw(fitted.edge.getShape())).toBeCloseTo(2 * Math.PI * 10, 5);
    const start = EdgeOps.getVertexPoint(fitted.edge.getFirstVertex());
    expect(start.x).toBeCloseTo(10);
    expect(start.y).toBeCloseTo(0);
  });

  it("renders an arc() statement with coincident ends as a whole circle", () => {
    const sk = sketch("xy", () => {
      arc([10, 0], [10, 0], [0, 0]);
    });
    render();
    const edges = (sk as unknown as { getEdges(): Edge[] }).getEdges();
    expect(edges).toHaveLength(1);
    expect(EdgeOps.getEdgeLengthRaw(edges[0].getShape())).toBeCloseTo(2 * Math.PI * 10, 5);
  });
});
