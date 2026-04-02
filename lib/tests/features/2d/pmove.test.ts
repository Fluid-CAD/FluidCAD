import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { pMove, rect } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

describe("pMove", () => {
  setupOC();

  it("should move cursor by polar coordinates (0° = right)", () => {
    sketch("xy", () => {
      pMove(50, 0);
      rect(20, 20);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(50, 0);
    expect(bbox.minY).toBeCloseTo(0, 0);
  });

  it("should move cursor by polar coordinates (90° = up)", () => {
    sketch("xy", () => {
      pMove(40, 90);
      rect(20, 20);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(0, 0);
    expect(bbox.minY).toBeCloseTo(40, 0);
  });

  it("should move cursor diagonally (45°)", () => {
    sketch("xy", () => {
      pMove(50, 45);
      rect(10, 10);
    });
    const e = extrude(5) as ExtrudeBase;
    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    const expected = 50 * Math.cos(Math.PI / 4);
    expect(bbox.minX).toBeCloseTo(expected, 0);
    expect(bbox.minY).toBeCloseTo(expected, 0);
  });
});
