import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import helix from "../../core/helix.js";
import { line } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { CurveOperand } from "../../helpers/curve-operand.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { TestSheets } from "./sheets.js";
import { TestCurves } from "./curves.js";
import { testRect } from "./profiles.js";
import { useLoadedBodies, loadShapes } from "./loaded-bodies.js";

const asObject = (value: unknown) => value as SceneObject;

function refusal(run: () => unknown): BuildError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return error as BuildError;
  }
  throw new Error("expected a BuildError");
}

const ends = (edge: Edge) => [edge.getFirstPoint(), edge.getLastPoint()].map(p => [p.x, p.y, p.z].map(v => +v.toFixed(6) + 0));

describe("CurveOperand", () => {
  setupOC();
  useLoadedBodies();

  describe("what an argument stands for", () => {
    it("a sketch: its edges, construction geometry left out", () => {
      const s = asObject(sketch("xy", () => {
        testRect(20, 10);
        line([-30, 0], [30, 0]).guide();
      }));
      render();

      const edges = CurveOperand.edges(s, "path");
      expect(edges.length).toBe(4);
    });

    it("a sketch statement: that statement's edges", () => {
      let middle: SceneObject = null!;
      sketch("xy", () => {
        line([0, 0], [10, 0]);
        middle = asObject(line([10, 0], [10, 10]));
        line([10, 10], [0, 10]);
      });
      render();

      const edges = CurveOperand.edges(middle, "path");
      expect(edges.map(ends)).toEqual([[[10, 0, 0], [10, 10, 0]]]);
    });

    it("a curve object: the edges of its wires and edges", () => {
      const l = asObject(loadShapes([
        TestCurves.threeEdges(),
        EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50)),
      ]));
      const coil = asObject(helix("z").radius(10).pitch(5).turns(2));
      render();

      expect(CurveOperand.edges(l, "path").length).toBe(4);
      expect(CurveOperand.edges(coil, "path").length).toBeGreaterThan(0);
    });

    it("a selection of edges: those edges", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      extrude(5);
      const top = asObject(select(edge().onPlane("xy", 5)));
      render();

      expect(CurveOperand.edges(top, "path").length).toBe(4);
      const wire = CurveOperand.closedLoop(top, "path");
      try {
        expect(wire.getEdges().length).toBe(4);
      } finally {
        wire.dispose();
      }
    });

    it("a selection of faces is refused, with a pointer to its edges", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      extrude(5);
      const faces = asObject(select(face().planar()));
      render();

      const error = refusal(() => CurveOperand.edges(faces, "sweep path"));
      expect(error.diagnostic).toBe("sweep path is a face selection; pick its edges.");
      expect(error.hint).toContain("edge()");
    });

    it("a solid or a surface is refused: the edges meant are never all of them", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      const e = asObject(extrude(5));
      const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
      render();

      expect(refusal(() => CurveOperand.wire(e, "sweep path")).diagnostic)
        .toBe("sweep path is a solid; pick the edges to use.");
      expect(refusal(() => CurveOperand.wires(l, "loft guide 1")).diagnostic)
        .toBe("loft guide 1 is a surface; pick the edges to use.");
    });

    it("an object with no edges says so", () => {
      const l = asObject(loadShapes([TestCurves.threeEdges()]));
      render();

      expect(refusal(() => CurveOperand.edges([], "path")).diagnostic).toBe("path has no edges to build a curve from.");
      expect(CurveOperand.edges([l], "path").length).toBe(3);
    });
  });

  describe("chaining", () => {
    it("chains in statement order: the earliest drawn chain first, walked from its earliest edge", () => {
      let s: SceneObject = null!;
      s = asObject(sketch("xy", () => {
        line([0, 20], [10, 20]);
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
        line([10, 20], [20, 20]);
      }));
      render();

      const edges = CurveOperand.edges(s, "guides");
      expect(edges.map(ends)).toEqual([
        [[0, 20, 0], [10, 20, 0]],
        [[0, 0, 0], [10, 0, 0]],
        [[10, 0, 0], [10, 10, 0]],
        [[10, 20, 0], [20, 20, 0]],
      ]);

      const wires = CurveOperand.wires(s, "guides");
      try {
        expect(wires.length).toBe(2);
        // The first chain is the one the first line belongs to: the y = 20 run.
        expect(wires[0].getEdges().every(e => Math.abs(e.getFirstPoint().y - 20) < 1e-9)).toBe(true);
        expect(wires[1].getEdges().length).toBe(2);
      } finally {
        wires.forEach(w => w.dispose());
      }
    });

    it("wire() refuses two chains and names the gap between them", () => {
      const s = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
        line([13, 10], [20, 10]);
      }));
      render();

      const error = refusal(() => CurveOperand.wire(s, "sweep path"));
      expect(error.diagnostic).toBe(
        "sweep path is 2 separate curves, not one connected curve; the nearest ends, (10, 10, 0) and (13, 10, 0), are 3 apart.",
      );
    });

    it("closedLoop() refuses an open chain and names both its ends", () => {
      const s = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
      }));
      render();

      const error = refusal(() => CurveOperand.closedLoop(s, "boundary"));
      expect(error.diagnostic).toBe("boundary is open: it ends at (0, 0, 0) and (10, 10, 0).");
    });

    it("a nearly closed sketch chains within tolerance into one closed loop", () => {
      const s = asObject(sketch("xy", () => {
        line([0, 0], [100, 0]);
        line([100, 0], [100, 100]);
        line([100, 100], [0, 100]);
        line([0, 100], [0, 0.01]);
      }));
      render();

      // The drawn ends really miss: the chain closes only within tolerance.
      expect(ends(CurveOperand.edges(s, "boundary")[3])[1]).toEqual([0, 0.01, 0]);
      const wire = CurveOperand.closedLoop(s, "boundary");
      try {
        expect(wire).toBeInstanceOf(Wire);
        expect(wire.getEdges().length).toBe(4);
        expect(CurveOperand.openEnds([wire])).toEqual([]);
      } finally {
        wire.dispose();
      }
    });
  });

  describe("planeOf", () => {
    it("the plane of a planar curve, none for a 3D or a straight one", () => {
      const s = asObject(sketch("front", () => {
        testRect(20, 10);
      }));
      const coil = asObject(helix("z").radius(10).pitch(5).turns(2));
      const straight = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [20, 0]);
      }));
      render();

      const plane = CurveOperand.planeOf(CurveOperand.edges(s, "profile"));
      expect(plane).not.toBeNull();
      expect(Math.abs(plane!.normal.y)).toBeCloseTo(1, 9);
      expect(plane!.origin.y).toBeCloseTo(0, 9);

      expect(CurveOperand.planeOf(CurveOperand.edges(coil, "coil"))).toBeNull();
      expect(CurveOperand.planeOf(CurveOperand.edges(straight, "line"))).toBeNull();
      expect(CurveOperand.planeOf([])).toBeNull();
    });
  });
});
