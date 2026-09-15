import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Mesh } from "../../oc/mesh.js";
import { ShapeOps } from "../../oc/shape-ops.js";

// A cylinder of radius 10 and height 20 along +Z, meshed coarsely so the
// triangulation's deflection is far above any tolerance.
function meshedCylinder() {
  const oc = getOC();
  const shape = new oc.BRepPrimAPI_MakeCylinder(10, 20).Shape();
  Mesh.ensureTriangulated(shape, { linDefl: 0.5, angDefl: 0.5 });
  return shape;
}

describe("ShapeOps bounding boxes", () => {
  setupOC();

  it("the sizing box grows by the mesh deflection once a shape is meshed", () => {
    const bb = ShapeOps.getBoundingBox(meshedCylinder());
    expect(bb.maxZ).toBeGreaterThan(20 + 0.01);
    expect(bb.minZ).toBeLessThan(-0.01);
  });

  it("the exact box ignores triangulation and adds no gap", () => {
    const bb = ShapeOps.getExactBoundingBox(meshedCylinder());
    expect(bb.minX).toBeCloseTo(-10, 6);
    expect(bb.maxX).toBeCloseTo(10, 6);
    expect(bb.minY).toBeCloseTo(-10, 6);
    expect(bb.maxY).toBeCloseTo(10, 6);
    expect(bb.minZ).toBeCloseTo(0, 6);
    expect(bb.maxZ).toBeCloseTo(20, 6);
    expect(bb.centerZ).toBeCloseTo(10, 6);
  });

  it("unions boxes and refuses an empty list", () => {
    const u = ShapeOps.unionBoundingBoxes([
      ShapeOps.getExactBoundingBox(meshedCylinder()),
      { minX: 5, minY: -30, minZ: 0, maxX: 6, maxY: 0, maxZ: 25, centerX: 5.5, centerY: -15, centerZ: 12.5 },
    ]);
    expect([u.minX, u.minY, u.minZ, u.maxX, u.maxY, u.maxZ]).toEqual([-10, -30, 0, 10, 10, 25]);
    expect(ShapeOps.boundingBoxCorners(u)).toHaveLength(8);
    expect(() => ShapeOps.unionBoundingBoxes([])).toThrow();
  });
});
