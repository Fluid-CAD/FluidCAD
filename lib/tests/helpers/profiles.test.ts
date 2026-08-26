import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import extrude from "../../core/extrude.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Solid } from "../../common/solid.js";
import { getBoundingBoxOfShapes } from "../utils.js";
import { testRect, testRectSketch } from "./profiles.js";
import sketch from "../../core/sketch.js";

describe("shared solved test profiles", () => {
  setupOC();

  it("testRectSketch extrudes to the legacy rect(w, h) box", () => {
    testRectSketch("xy", 100, 50);
    const e = extrude(10) as ExtrudeBase;
    render();

    expect(e.getShapes()).toHaveLength(1);
    const bbox = getBoundingBoxOfShapes([e.getShapes()[0] as Solid]);
    expect(bbox.minX).toBeCloseTo(0, 4);
    expect(bbox.maxX).toBeCloseTo(100, 4);
    expect(bbox.minY).toBeCloseTo(0, 4);
    expect(bbox.maxY).toBeCloseTo(50, 4);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(10, 4);
  });

  it("testRect honors at-offsets and negative spans like the legacy pen form", () => {
    sketch("xy", () => {
      testRect(-30, 8, { at: [10, 5] });
    });
    const e = extrude(4) as ExtrudeBase;
    render();

    const bbox = getBoundingBoxOfShapes([e.getShapes()[0] as Solid]);
    expect(bbox.minX).toBeCloseTo(-20, 4);
    expect(bbox.maxX).toBeCloseTo(10, 4);
    expect(bbox.minY).toBeCloseTo(5, 4);
    expect(bbox.maxY).toBeCloseTo(13, 4);
  });
});
