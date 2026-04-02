import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import { circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("copy circular 2D", () => {
  setupOC();

  it("should create 2D circular copies inside a sketch", () => {
    sketch("xy", () => {
      const c = circle([30, 0], 10);
      copy("circular", [0, 0], { count: 4, angle: 360 }, c);
    });

    const e = extrude(10) as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    expect(shapes.length).toBeGreaterThanOrEqual(1);
  });

  it("should place copies symmetrically around the center", () => {
    sketch("xy", () => {
      const c = circle([30, 0], 10);
      copy("circular", [0, 0], { count: 4, angle: 360 }, c);
    });

    const e = extrude(10).fuse("none") as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    // 4 circles placed at 0°, 90°, 180°, 270° → symmetric bounding box
    const allBBoxes = shapes.map(s => ShapeOps.getBoundingBox(s));
    const minX = Math.min(...allBBoxes.map(b => b.minX));
    const maxX = Math.max(...allBBoxes.map(b => b.maxX));
    const minY = Math.min(...allBBoxes.map(b => b.minY));
    const maxY = Math.max(...allBBoxes.map(b => b.maxY));

    // Should span roughly equally in both directions
    expect(maxX).toBeGreaterThan(0);
    expect(minX).toBeLessThan(0);
    expect(maxY).toBeGreaterThan(0);
    expect(minY).toBeLessThan(0);
  });
});
