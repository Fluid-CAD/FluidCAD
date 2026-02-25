import { describe, it, expect } from "vitest";
import { CoordinateSystem } from "./coordinate-system.js";
import { Point } from "./point.js";
import { Vector3d } from "./vector3d.js";
import { Axis } from "./axis.js";
import { Plane } from "./plane.js";

describe("CoordinateSystem", () => {
  describe("constructor", () => {
    it("creates coordinate system with origin, mainDirection, xDirection", () => {
      const origin = new Point(1, 2, 3);
      const mainDir = Vector3d.unitZ();
      const xDir = Vector3d.unitX();
      const cs = new CoordinateSystem(origin, mainDir, xDir);

      expect(cs.origin.equals(origin)).toBe(true);
      expect(cs.mainDirection.equals(mainDir)).toBe(true);
      expect(cs.xDirection.equals(xDir)).toBe(true);
    });

    it("computes yDirection automatically", () => {
      const cs = CoordinateSystem.World();
      expect(cs.yDirection.x).toBeCloseTo(0);
      expect(cs.yDirection.y).toBeCloseTo(1);
      expect(cs.yDirection.z).toBeCloseTo(0);
    });
  });

  describe("World", () => {
    it("returns world coordinate system", () => {
      const world = CoordinateSystem.World();
      expect(world.origin.equals(Point.origin())).toBe(true);
      expect(world.mainDirection.equals(Vector3d.unitZ())).toBe(true);
      expect(world.xDirection.equals(Vector3d.unitX())).toBe(true);
    });

    it("returns same instance", () => {
      const w1 = CoordinateSystem.World();
      const w2 = CoordinateSystem.World();
      expect(w1).toBe(w2);
    });
  });

  describe("axes", () => {
    it("xAxis returns axis along X direction", () => {
      const cs = CoordinateSystem.World();
      const axis = cs.xAxis;
      expect(axis.origin.equals(cs.origin)).toBe(true);
      expect(axis.direction.equals(cs.xDirection)).toBe(true);
    });

    it("yAxis returns axis along Y direction", () => {
      const cs = CoordinateSystem.World();
      const axis = cs.yAxis;
      expect(axis.direction.equals(cs.yDirection)).toBe(true);
    });

    it("mainAxis returns axis along main direction", () => {
      const cs = CoordinateSystem.World();
      const axis = cs.mainAxis;
      expect(axis.direction.equals(cs.mainDirection)).toBe(true);
    });

    it("zAxis is same as mainAxis", () => {
      const cs = CoordinateSystem.World();
      expect(cs.zAxis.direction.equals(cs.mainAxis.direction)).toBe(true);
    });
  });

  describe("angle", () => {
    it("returns 0 for same orientation", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(new Point(5, 5, 5), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.angle(cs2)).toBeCloseTo(0);
    });

    it("returns PI/2 for perpendicular", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(Point.origin(), Vector3d.unitX(), Vector3d.unitY());
      expect(cs1.angle(cs2)).toBeCloseTo(Math.PI / 2);
    });
  });

  describe("isCoplanar", () => {
    it("returns true for coplanar systems", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(new Point(5, 5, 0), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.isCoplanar(cs2)).toBe(true);
    });

    it("returns false for non-coplanar systems", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(new Point(0, 0, 10), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.isCoplanar(cs2)).toBe(false);
    });

    it("returns false for different orientations", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(Point.origin(), Vector3d.unitX(), Vector3d.unitY());
      expect(cs1.isCoplanar(cs2)).toBe(false);
    });
  });

  describe("translate", () => {
    it("translates origin, keeps orientation", () => {
      const cs = CoordinateSystem.World();
      const translated = cs.translate(1, 2, 3);
      expect(translated.origin.x).toBe(1);
      expect(translated.origin.y).toBe(2);
      expect(translated.origin.z).toBe(3);
      expect(translated.mainDirection.equals(cs.mainDirection)).toBe(true);
    });
  });

  describe("translateVector", () => {
    it("translates by vector", () => {
      const cs = CoordinateSystem.World();
      const translated = cs.translateVector(new Vector3d(5, 10, 15));
      expect(translated.origin.x).toBe(5);
      expect(translated.origin.y).toBe(10);
      expect(translated.origin.z).toBe(15);
    });
  });

  describe("rotate", () => {
    it("rotates around axis", () => {
      const cs = CoordinateSystem.World();
      const rotated = cs.rotate(Axis.Z(), Math.PI / 2);
      expect(rotated.xDirection.x).toBeCloseTo(0);
      expect(rotated.xDirection.y).toBeCloseTo(1);
    });
  });

  describe("scale", () => {
    it("scales origin distance from point", () => {
      const cs = new CoordinateSystem(new Point(2, 0, 0), Vector3d.unitZ(), Vector3d.unitX());
      const scaled = cs.scale(Point.origin(), 2);
      expect(scaled.origin.x).toBeCloseTo(4);
      // Direction should not change
      expect(scaled.mainDirection.equals(cs.mainDirection)).toBe(true);
    });
  });

  describe("mirror methods", () => {
    it("mirrorAroundPoint mirrors through point", () => {
      const cs = new CoordinateSystem(new Point(2, 0, 0), Vector3d.unitZ(), Vector3d.unitX());
      const mirrored = cs.mirrorAroundPoint(Point.origin());
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });

    it("mirrorAroundAxis mirrors through axis", () => {
      const cs = new CoordinateSystem(new Point(2, 0, 0), Vector3d.unitZ(), Vector3d.unitX());
      const mirrored = cs.mirrorAroundAxis(Axis.Z());
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });

    it("mirrorAroundPlane mirrors through plane", () => {
      const cs = new CoordinateSystem(new Point(0, 0, 5), Vector3d.unitZ(), Vector3d.unitX());
      const mirrored = cs.mirrorAroundPlane(Vector3d.unitZ(), Point.origin());
      expect(mirrored.origin.z).toBeCloseTo(-5);
    });
  });

  describe("getXYPlane", () => {
    it("returns XY plane of coordinate system", () => {
      const cs = CoordinateSystem.World();
      const plane = cs.getXYPlane();
      expect(plane.origin.equals(cs.origin)).toBe(true);
      expect(plane.normal.equals(cs.mainDirection)).toBe(true);
    });
  });

  describe("getXZPlane", () => {
    it("returns XZ plane of coordinate system", () => {
      const cs = CoordinateSystem.World();
      const plane = cs.getXZPlane();
      expect(plane.origin.equals(cs.origin)).toBe(true);
      expect(plane.xDirection.equals(cs.xDirection)).toBe(true);
    });
  });

  describe("getYZPlane", () => {
    it("returns YZ plane of coordinate system", () => {
      const cs = CoordinateSystem.World();
      const plane = cs.getYZPlane();
      expect(plane.origin.equals(cs.origin)).toBe(true);
      expect(plane.xDirection.equals(cs.yDirection)).toBe(true);
    });
  });

  describe("worldToLocal", () => {
    it("converts world point to local coordinates", () => {
      const cs = CoordinateSystem.World();
      const world = new Point(3, 4, 5);
      const local = cs.worldToLocal(world);
      expect(local.x).toBeCloseTo(3);
      expect(local.y).toBeCloseTo(4);
      expect(local.z).toBeCloseTo(5);
    });

    it("handles offset origin", () => {
      const cs = new CoordinateSystem(new Point(10, 20, 30), Vector3d.unitZ(), Vector3d.unitX());
      const world = new Point(15, 25, 35);
      const local = cs.worldToLocal(world);
      expect(local.x).toBeCloseTo(5);
      expect(local.y).toBeCloseTo(5);
      expect(local.z).toBeCloseTo(5);
    });
  });

  describe("localToWorld", () => {
    it("converts local coordinates to world point", () => {
      const cs = CoordinateSystem.World();
      const local = new Point(3, 4, 5);
      const world = cs.localToWorld(local);
      expect(world.x).toBeCloseTo(3);
      expect(world.y).toBeCloseTo(4);
      expect(world.z).toBeCloseTo(5);
    });

    it("handles offset origin", () => {
      const cs = new CoordinateSystem(new Point(10, 20, 30), Vector3d.unitZ(), Vector3d.unitX());
      const local = new Point(5, 5, 5);
      const world = cs.localToWorld(local);
      expect(world.x).toBeCloseTo(15);
      expect(world.y).toBeCloseTo(25);
      expect(world.z).toBeCloseTo(35);
    });
  });

  describe("worldToLocal and localToWorld roundtrip", () => {
    it("roundtrip returns original point", () => {
      const cs = new CoordinateSystem(
        new Point(10, 20, 30),
        new Vector3d(0, 0, 1),
        new Vector3d(1, 0, 0)
      );
      const original = new Point(50, 60, 70);
      const local = cs.worldToLocal(original);
      const back = cs.localToWorld(local);
      expect(back.x).toBeCloseTo(original.x);
      expect(back.y).toBeCloseTo(original.y);
      expect(back.z).toBeCloseTo(original.z);
    });

    it("roundtrip works with rotated system", () => {
      const cs = new CoordinateSystem(
        Point.origin(),
        new Vector3d(1, 0, 0),
        new Vector3d(0, 1, 0)
      );
      const local = new Point(3, 4, 5);
      const world = cs.localToWorld(local);
      const backToLocal = cs.worldToLocal(world);
      expect(backToLocal.x).toBeCloseTo(local.x);
      expect(backToLocal.y).toBeCloseTo(local.y);
      expect(backToLocal.z).toBeCloseTo(local.z);
    });
  });

  describe("worldToLocalVector", () => {
    it("converts world vector to local coordinates", () => {
      const cs = CoordinateSystem.World();
      const world = new Vector3d(1, 0, 0);
      const local = cs.worldToLocalVector(world);
      expect(local.x).toBeCloseTo(1);
      expect(local.y).toBeCloseTo(0);
      expect(local.z).toBeCloseTo(0);
    });
  });

  describe("localToWorldVector", () => {
    it("converts local vector to world coordinates", () => {
      const cs = CoordinateSystem.World();
      const local = new Vector3d(1, 0, 0);
      const world = cs.localToWorldVector(local);
      expect(world.x).toBeCloseTo(1);
      expect(world.y).toBeCloseTo(0);
      expect(world.z).toBeCloseTo(0);
    });
  });

  describe("getBasisMatrix", () => {
    it("returns basis transformation matrix", () => {
      const cs = CoordinateSystem.World();
      const matrix = cs.getBasisMatrix();
      const p = matrix.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(1);
      expect(p.y).toBeCloseTo(0);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("getInverseBasisMatrix", () => {
    it("returns inverse basis matrix", () => {
      const cs = CoordinateSystem.World();
      const matrix = cs.getBasisMatrix();
      const inverse = cs.getInverseBasisMatrix();
      const result = matrix.multiply(inverse);
      // Should be identity
      expect(result.get(0, 0)).toBeCloseTo(1);
      expect(result.get(1, 1)).toBeCloseTo(1);
      expect(result.get(2, 2)).toBeCloseTo(1);
    });
  });

  describe("equals", () => {
    it("returns true for identical systems", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(Point.origin(), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.equals(cs2)).toBe(true);
    });

    it("returns false for different systems", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(new Point(1, 0, 0), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.equals(cs2)).toBe(false);
    });

    it("supports tolerance", () => {
      const cs1 = CoordinateSystem.World();
      const cs2 = new CoordinateSystem(new Point(0.001, 0, 0), Vector3d.unitZ(), Vector3d.unitX());
      expect(cs1.equals(cs2, 0.01)).toBe(true);
    });
  });

  describe("fromPlane", () => {
    it("creates coordinate system from plane", () => {
      const plane = Plane.XY();
      const cs = CoordinateSystem.fromPlane(plane);
      expect(cs.origin.equals(plane.origin)).toBe(true);
      expect(cs.mainDirection.equals(plane.normal)).toBe(true);
      expect(cs.xDirection.equals(plane.xDirection)).toBe(true);
    });

    it("creates from plane string", () => {
      const cs = CoordinateSystem.fromPlane("xy");
      expect(cs.mainDirection.z).toBeCloseTo(1);
    });
  });

  describe("fromTwoAxes", () => {
    it("creates coordinate system from two axes", () => {
      const cs = CoordinateSystem.fromTwoAxes(
        Point.origin(),
        Vector3d.unitZ(),
        Vector3d.unitX()
      );
      expect(cs.mainDirection.z).toBeCloseTo(1);
    });
  });

  describe("clone", () => {
    it("creates independent copy", () => {
      const cs = CoordinateSystem.World();
      const clone = cs.clone();
      expect(clone.equals(cs)).toBe(true);
      expect(clone).not.toBe(cs);
    });
  });
});
