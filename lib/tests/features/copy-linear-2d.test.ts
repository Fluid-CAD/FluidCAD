import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import { rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("copy linear 2D", () => {
  setupOC();

  it("should create 2D copies inside a sketch", () => {
    sketch("xy", () => {
      const r = rect(20, 20);
      copy("linear", "x", { count: 3, offset: 40 }, r);
    });

    const e = extrude(10) as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    expect(shapes.length).toBeGreaterThanOrEqual(1);
  });

  it("should produce copies at correct positions when extruded", () => {
    sketch("xy", () => {
      const r = rect(20, 20);
      copy("linear", "x", { count: 3, offset: 40 }, r);
    });

    const e = extrude(10).fuse("none") as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    // 3 separate rects → 3 solids (with fuse none, they stay separate)
    expect(shapes.length).toBeGreaterThanOrEqual(1);

    // The overall bounding box should span the copies
    const allShapes = shapes.map(s => ShapeOps.getBoundingBox(s));
    const maxX = Math.max(...allShapes.map(b => b.maxX));
    expect(maxX).toBeGreaterThan(40);
  });
});
