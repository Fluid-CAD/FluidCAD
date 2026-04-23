import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sphere from "../../core/sphere.js";
import cylinder from "../../core/cylinder.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SceneObject } from "../../common/scene-object.js";

describe("chained transforms on primitive shapes", () => {
  setupOC();

  it("applies .translate() on a cylinder", () => {
    const c = cylinder(5, 10).translate(20, 0, 0) as unknown as SceneObject;

    render();

    const shapes = c.getShapes();
    expect(shapes).toHaveLength(1);
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minX).toBeCloseTo(15, 0);
    expect(bbox.maxX).toBeCloseTo(25, 0);
  });

  it("composes chained transforms left-to-right on a sphere", () => {
    const s = sphere(1).translate(5, 0, 0).rotate("z", 90) as unknown as SceneObject;

    render();

    const shapes = s.getShapes();
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    expect(cx).toBeCloseTo(0, 1);
    expect(cy).toBeCloseTo(5, 1);
  });

  it("accepts a PointLike array in .translate()", () => {
    const s = sphere(1).translate([7, 8, 9]) as unknown as SceneObject;

    render();

    const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const cz = (bbox.minZ + bbox.maxZ) / 2;
    expect(cx).toBeCloseTo(7, 1);
    expect(cy).toBeCloseTo(8, 1);
    expect(cz).toBeCloseTo(9, 1);
  });

  it("chained .mirror() across a plane", () => {
    const c = cylinder(5, 10).translate(15, 0, 0).mirror("yz") as unknown as SceneObject;

    render();

    const bbox = ShapeOps.getBoundingBox(c.getShapes()[0]);
    expect(bbox.maxX).toBeCloseTo(-10, 0);
    expect(bbox.minX).toBeCloseTo(-20, 0);
  });
});
