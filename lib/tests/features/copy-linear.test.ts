import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import { rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("copy linear", () => {
  setupOC();

  it("should create copies along an axis", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    copy("linear", "x", { count: 3, offset: 40 }, e);

    const scene = render();

    // Original + 2 copies = 3 shapes
    expect(countShapes(scene)).toBe(3);
  });

  it("should space copies by the given offset", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    const c = copy("linear", "x", { count: 3, offset: 50 }, e) as SceneObject;

    render();

    // 2 copies (index 1 and 2), each offset by 50 along X
    const shapes = c.getShapes();
    expect(shapes).toHaveLength(2);

    const bbox1 = ShapeOps.getBoundingBox(shapes[0]);
    const bbox2 = ShapeOps.getBoundingBox(shapes[1]);
    expect(bbox1.minX).toBeCloseTo(50, 0);
    expect(bbox2.minX).toBeCloseTo(100, 0);
  });

  it("should copy along Y axis", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    const c = copy("linear", "y", { count: 2, offset: 60 }, e) as SceneObject;

    render();

    const shapes = c.getShapes();
    expect(shapes).toHaveLength(1);

    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minY).toBeCloseTo(60, 0);
  });

  it("should copy along Z axis", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    const c = copy("linear", "z", { count: 2, offset: 30 }, e) as SceneObject;

    render();

    const shapes = c.getShapes();
    expect(shapes).toHaveLength(1);

    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minZ).toBeCloseTo(30, 0);
  });

  it("should distribute copies by total length", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 4 copies over length 120 → offset = 120/(4-1) = 40
    const c = copy("linear", "x", { count: 4, length: 120 }, e) as SceneObject;

    render();

    const shapes = c.getShapes();
    expect(shapes).toHaveLength(3);

    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minX).toBeCloseTo(40, 0);
  });

  it("should create a 2D grid with multiple axes", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3 along X, 2 along Y → 3×2 = 6 positions, minus original = 5 copies
    copy("linear", ["x", "y"], { count: [3, 2], offset: 30 }, e);

    const scene = render();

    // Original (1) + copies (5) = 6
    expect(countShapes(scene)).toBe(6);
  });

  it("should skip specified positions", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3 copies, skip index 1
    copy("linear", "x", { count: 3, offset: 30, skip: [[1]] }, e);

    const scene = render();

    // Original (1) + 1 copy (skipped index 1, kept index 2) = 2
    expect(countShapes(scene)).toBe(2);
  });
});
