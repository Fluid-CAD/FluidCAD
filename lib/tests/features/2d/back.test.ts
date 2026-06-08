import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { move, hMove, back, rect, hLine, vLine, tLine } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Edge } from "../../../common/edge.js";

describe("back", () => {
  setupOC();

  it("should revert cursor to the previous position", () => {
    sketch("xy", () => {
      move([30, 20]);
      move([100, 100]);
      back();
      rect(10, 10);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(30, 0);
    expect(bbox.minY).toBeCloseTo(20, 0);
  });

  it("should revert N positions back when given a count", () => {
    sketch("xy", () => {
      hMove(10);
      hMove(20);
      hMove(40);
      back(2);
      rect(5, 5);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(10, 0);
    expect(bbox.minY).toBeCloseTo(0, 0);
  });

  it("should fall back to sketch start point when count exceeds history", () => {
    sketch("xy", () => {
      hMove(50);
      back(99);
      rect(10, 10);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(0, 0);
    expect(bbox.minY).toBeCloseTo(0, 0);
  });

  it("should toggle on consecutive back() calls", () => {
    sketch("xy", () => {
      hMove(40);
      back();
      back();
      rect(10, 10);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(40, 0);
  });

  it("should restore the tangent to its prior value, not just the position", () => {
    let t: any;
    sketch("xy", () => {
      hLine(10);     // tangent (+1, 0), pos (10, 0)
      vLine(10);     // tangent (0, +1), pos (10, 10)
      back();        // pos reverts to (10, 0); tangent should revert to (+1, 0)
      t = tLine(5);  // with restored tangent, this should go to (15, 0)
    });
    render();

    const edges = t.getOwnShapes().filter((sh: any) => sh instanceof Edge) as Edge[];
    expect(edges).toHaveLength(1);
    const endPoint = edges[0].getLastVertex().toPoint();
    expect(endPoint.x).toBeCloseTo(15, 1);
    expect(endPoint.y).toBeCloseTo(0, 1);
  });
});
