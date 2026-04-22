import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import sphere from "../../core/sphere.js";
import { rect } from "../../core/2d/index.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SceneObject } from "../../common/scene-object.js";

describe("chained transforms on scene objects", () => {
  setupOC();

  it("applies .translate() from chained call", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new().translate(50) as unknown as SceneObject;

    render();

    const shapes = e.getShapes();
    expect(shapes).toHaveLength(1);
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minX).toBeCloseTo(50, 0);
    expect(bbox.maxX).toBeCloseTo(70, 0);
  });

  it("composes chained transforms left-to-right", () => {
    const s = (sphere(1) as SceneObject).translate(5, 0, 0).rotate("z", 90) as unknown as SceneObject;

    render();

    const shapes = s.getShapes();
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    expect(cx).toBeCloseTo(0, 1);
    expect(cy).toBeCloseTo(5, 1);
  });

  it("composes multiple translates into a single offset", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new().translate(3, 0, 0).translate(0, 4, 0) as unknown as SceneObject;

    render();

    const shapes = e.getShapes();
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minX).toBeCloseTo(3, 0);
    expect(bbox.minY).toBeCloseTo(4, 0);
  });

  it("chained translate with a PointLike array", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new().translate([7, 8, 9]) as unknown as SceneObject;

    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.minX).toBeCloseTo(7, 0);
    expect(bbox.minY).toBeCloseTo(8, 0);
    expect(bbox.minZ).toBeCloseTo(9, 0);
  });

  it("chained mirror across a plane", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new().translate(5, 0, 0).mirror("yz") as unknown as SceneObject;

    render();

    const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
    expect(bbox.maxX).toBeCloseTo(-5, 0);
    expect(bbox.minX).toBeCloseTo(-25, 0);
  });
});
