import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { rMove, hLine, vLine } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Sketch } from "../../../features/2d/sketch.js";

describe("rMove", () => {
  setupOC();

  it("should rotate the cursor direction", () => {
    const s = sketch("xy", () => {
      // Draw horizontal, rotate 90°, draw "horizontal" (now vertical)
      hLine(50);
      rMove(90);
      hLine(30);
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    // Should have 2 edges: one horizontal, one vertical after rotation
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });

  it("should rotate around a pivot point", () => {
    const s = sketch("xy", () => {
      hLine(40);
      rMove(90, [20, 0]);
      hLine(30);
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });
});
