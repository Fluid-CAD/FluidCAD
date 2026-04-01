import { describe, it, expect } from "vitest";
import { Plane, toPlane, isPlaneLike } from "../../math/plane.js";
import { Point, Point2D } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { Axis } from "../../math/axis.js";

describe("Plane", () => {
  describe("constructor", () => {
    it("creates plane with origin, xDirection, and normal", () => {
      const origin = new Point(1, 2, 3);
      const xDir = Vector3d.unitX();
      const normal = Vector3d.unitZ();
      const plane = new Plane(origin, xDir, normal);

      expect(plane.origin.equals(origin)).toBe(true);
      expect(plane.xDirection.equals(xDir)).toBe(true);
      expect(plane.normal.equals(normal)).toBe(true);
    });

    it("computes yDirection automatically", () => {
      const plane = Plane.XY();
      expect(plane.yDirection.x).toBeCloseTo(0);
      expect(plane.yDirection.y).toBeCloseTo(1);
      expect(plane.yDirection.z).toBeCloseTo(0);
    });

    it("creates axes", () => {
      const plane = Plane.XY();
      expect(plane.xAxis).toBeInstanceOf(Axis);
      expect(plane.yAxis).toBeInstanceOf(Axis);
      expect(plane.zAxis).toBeInstanceOf(Axis);
    });
  });

  describe("standard planes", () => {
    it("XY plane at origin with Z normal", () => {
      const plane = Plane.XY();
      expect(plane.origin.equals(Point.origin())).toBe(true);
      expect(plane.normal.equals(Vector3d.unitZ())).toBe(true);
      expect(plane.xDirection.equals(Vector3d.unitX())).toBe(true);
    });

    it("XZ plane at origin with -Y normal", () => {
      const plane = Plane.XZ();
      expect(plane.origin.equals(Point.origin())).toBe(true);
      expect(plane.normal.y).toBeCloseTo(-1);
    });

    it("YZ plane at origin with X normal", () => {
      const plane = Plane.YZ();
      expect(plane.origin.equals(Point.origin())).toBe(true);
      expect(plane.normal.equals(Vector3d.unitX())).toBe(true);
    });
  });

  describe("worldToLocal", () => {
    it("converts world point to local 2D coordinates", () => {
      const plane = Plane.XY();
      const worldPoint = new Point(3, 4, 0);
      const local = plane.worldToLocal(worldPoint);
      expect(local.x).toBeCloseTo(3);
      expect(local.y).toBeCloseTo(4);
    });

    it("ignores z component for XY plane", () => {
      const plane = Plane.XY();
      const worldPoint = new Point(3, 4, 100);
      const local = plane.worldToLocal(worldPoint);
      expect(local.x).toBeCloseTo(3);
      expect(local.y).toBeCloseTo(4);
    });

    it("works with offset plane", () => {
      const plane = new Plane(new Point(10, 20, 0), Vector3d.unitX(), Vector3d.unitZ());
      const worldPoint = new Point(15, 25, 0);
      const local = plane.worldToLocal(worldPoint);
      expect(local.x).toBeCloseTo(5);
      expect(local.y).toBeCloseTo(5);
    });
  });

  describe("localToWorld", () => {
    it("converts local 2D coordinates to world point", () => {
      const plane = Plane.XY();
      const local = new Point2D(3, 4);
      const world = plane.localToWorld(local);
      expect(world.x).toBeCloseTo(3);
      expect(world.y).toBeCloseTo(4);
      expect(world.z).toBeCloseTo(0);
    });

    it("works with offset plane", () => {
      const plane = new Plane(new Point(10, 20, 30), Vector3d.unitX(), Vector3d.unitZ());
      const local = new Point2D(5, 5);
      const world = plane.localToWorld(local);
      expect(world.x).toBeCloseTo(15);
      expect(world.y).toBeCloseTo(25);
      expect(world.z).toBeCloseTo(30);
    });
  });

  describe("worldToLocal and localToWorld roundtrip", () => {
    it("roundtrip returns original point (on plane)", () => {
      const plane = Plane.XY();
      const original = new Point(7, 11, 0);
      const local = plane.worldToLocal(original);
      const back = plane.localToWorld(local);
      expect(back.x).toBeCloseTo(original.x);
      expect(back.y).toBeCloseTo(original.y);
      expect(back.z).toBeCloseTo(original.z);
    });

    it("roundtrip works with rotated plane", () => {
      const plane = new Plane(
        Point.origin(),
        new Vector3d(1, 1, 0).normalize(),
        Vector3d.unitZ()
      );
      const local = new Point2D(5, 3);
      const world = plane.localToWorld(local);
      const backToLocal = plane.worldToLocal(world);
      expect(backToLocal.x).toBeCloseTo(local.x);
      expect(backToLocal.y).toBeCloseTo(local.y);
    });
  });

  describe("offset", () => {
    it("offsets plane along normal", () => {
      const plane = Plane.XY();
      const offset = plane.offset(10);
      expect(offset.origin.z).toBe(10);
      expect(offset.normal.equals(plane.normal)).toBe(true);
    });

    it("negative offset moves in opposite direction", () => {
      const plane = Plane.XY();
      const offset = plane.offset(-5);
      expect(offset.origin.z).toBe(-5);
    });
  });

  describe("transform", () => {
    it("applies offset", () => {
      const plane = Plane.XY();
      const transformed = plane.transform({ offset: 10 });
      expect(transformed.origin.z).toBeCloseTo(10);
    });

    it("applies rotation around X", () => {
      const plane = Plane.XY();
      const transformed = plane.transform({ rotateX: 90 });
      // Rotating (0,0,1) by 90° around X gives (0,-1,0) in right-hand convention
      expect(transformed.normal.y).toBeCloseTo(-1);
      expect(transformed.normal.z).toBeCloseTo(0);
    });

    it("applies rotation around Z", () => {
      const plane = Plane.XY();
      const transformed = plane.transform({ rotateZ: 90 });
      expect(transformed.xDirection.x).toBeCloseTo(0);
      expect(transformed.xDirection.y).toBeCloseTo(1);
    });

    it("combines transformations without gimbal lock", () => {
      const plane = Plane.XY();
      // 90° Y rotation would cause gimbal lock with sequential Euler angles
      const transformed = plane.transform({
        rotateX: 45,
        rotateY: 90,
        rotateZ: 45,
      });
      // Should complete without issues and produce valid plane
      expect(transformed.normal.length()).toBeCloseTo(1);
      expect(transformed.xDirection.length()).toBeCloseTo(1);
    });
  });

  describe("translate", () => {
    it("translates plane origin", () => {
      const plane = Plane.XY();
      const translated = plane.translate(1, 2, 3);
      expect(translated.origin.x).toBe(1);
      expect(translated.origin.y).toBe(2);
      expect(translated.origin.z).toBe(3);
      expect(translated.normal.equals(plane.normal)).toBe(true);
    });
  });

  describe("translateVector", () => {
    it("translates by vector", () => {
      const plane = Plane.XY();
      const translated = plane.translateVector(new Vector3d(5, 10, 15));
      expect(translated.origin.x).toBe(5);
      expect(translated.origin.y).toBe(10);
      expect(translated.origin.z).toBe(15);
    });
  });

  describe("rotateAroundAxis", () => {
    it("rotates plane around axis", () => {
      const plane = Plane.XY();
      const axis = Axis.X();
      const rotated = plane.rotateAroundAxis(axis, Math.PI / 2);
      // Rotating (0,0,1) by π/2 around X gives (0,-1,0) in right-hand convention
      expect(rotated.normal.y).toBeCloseTo(-1);
      expect(rotated.normal.z).toBeCloseTo(0);
    });
  });

  describe("projectPoint", () => {
    it("projects point onto plane", () => {
      const plane = Plane.XY();
      const point = new Point(3, 4, 10);
      const projected = plane.projectPoint(point);
      expect(projected.x).toBeCloseTo(3);
      expect(projected.y).toBeCloseTo(4);
      expect(projected.z).toBeCloseTo(0);
    });
  });

  describe("distanceToPoint", () => {
    it("returns absolute distance to plane", () => {
      const plane = Plane.XY();
      expect(plane.distanceToPoint(new Point(0, 0, 5))).toBe(5);
      expect(plane.distanceToPoint(new Point(0, 0, -5))).toBe(5);
    });
  });

  describe("signedDistanceToPoint", () => {
    it("returns positive distance for point above plane", () => {
      const plane = Plane.XY();
      expect(plane.signedDistanceToPoint(new Point(0, 0, 5))).toBe(5);
    });

    it("returns negative distance for point below plane", () => {
      const plane = Plane.XY();
      expect(plane.signedDistanceToPoint(new Point(0, 0, -5))).toBe(-5);
    });
  });

  describe("containsPoint", () => {
    it("returns true for point on plane", () => {
      const plane = Plane.XY();
      expect(plane.containsPoint(new Point(5, 5, 0))).toBe(true);
    });

    it("returns false for point off plane", () => {
      const plane = Plane.XY();
      expect(plane.containsPoint(new Point(5, 5, 1))).toBe(false);
    });

    it("supports tolerance", () => {
      const plane = Plane.XY();
      expect(plane.containsPoint(new Point(5, 5, 0.001), 0.01)).toBe(true);
    });
  });

  describe("isParallelTo", () => {
    it("returns true for parallel planes", () => {
      const p1 = Plane.XY();
      const p2 = Plane.XY().offset(10);
      expect(p1.isParallelTo(p2)).toBe(true);
    });

    it("returns false for non-parallel planes", () => {
      const p1 = Plane.XY();
      const p2 = Plane.XZ();
      expect(p1.isParallelTo(p2)).toBe(false);
    });
  });

  describe("isCoplanarWith", () => {
    it("returns true for same plane", () => {
      const p1 = Plane.XY();
      const p2 = new Plane(new Point(5, 5, 0), Vector3d.unitX(), Vector3d.unitZ());
      expect(p1.isCoplanarWith(p2)).toBe(true);
    });

    it("returns false for parallel but offset planes", () => {
      const p1 = Plane.XY();
      const p2 = Plane.XY().offset(10);
      expect(p1.isCoplanarWith(p2)).toBe(false);
    });
  });

  describe("reverse", () => {
    it("reverses normal and xDirection", () => {
      const plane = Plane.XY();
      const reversed = plane.reverse();
      expect(reversed.normal.z).toBe(-1);
      expect(reversed.xDirection.x).toBe(-1);
    });
  });

  describe("mirror methods", () => {
    it("mirrorAroundPoint mirrors through point", () => {
      const plane = new Plane(new Point(2, 0, 0), Vector3d.unitX(), Vector3d.unitZ());
      const mirrored = plane.mirrorAroundPoint(Point.origin());
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });

    it("mirrorAroundPlane mirrors through plane", () => {
      const plane = Plane.XY().offset(5);
      const mirrored = plane.mirrorAroundPlane(Vector3d.unitZ(), Point.origin());
      expect(mirrored.origin.z).toBeCloseTo(-5);
    });

    it("mirrorAroundAxis mirrors through axis", () => {
      const plane = new Plane(new Point(2, 0, 0), Vector3d.unitY(), Vector3d.unitZ());
      const mirrored = plane.mirrorAroundAxis(Axis.Z());
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });

    it("mirrorAroundPlane preserves yDirection when it has no component along mirror normal", () => {
      // Mirror XY plane around YZ plane (flip X)
      // yDirection (0,1,0) has no X component, so it should stay (0,1,0)
      const plane = Plane.XY();
      const mirrored = plane.mirrorAroundPlane(Vector3d.unitX(), Point.origin());
      expect(mirrored.yDirection.x).toBeCloseTo(0);
      expect(mirrored.yDirection.y).toBeCloseTo(1);
      expect(mirrored.yDirection.z).toBeCloseTo(0);
    });

    it("mirrorAroundPlane gives correct localToWorld after mirror", () => {
      // Mirror XY plane around YZ plane (flip X)
      // A point at local (0, 5) should map to world (0, 5, 0), not (0, -5, 0)
      const plane = Plane.XY();
      const mirrored = plane.mirrorAroundPlane(Vector3d.unitX(), Point.origin());
      const world = mirrored.localToWorld(new Point2D(0, 5));
      expect(world.x).toBeCloseTo(0);
      expect(world.y).toBeCloseTo(5);
      expect(world.z).toBeCloseTo(0);
    });

    it("mirrorAroundPlane flips yDirection when it has a component along mirror normal", () => {
      // Mirror XY plane around XZ plane (flip Y)
      // yDirection (0,1,0) has Y component, so it should become (0,-1,0)
      const plane = Plane.XY();
      const mirrored = plane.mirrorAroundPlane(Vector3d.unitY(), Point.origin());
      expect(mirrored.yDirection.x).toBeCloseTo(0);
      expect(mirrored.yDirection.y).toBeCloseTo(-1);
      expect(mirrored.yDirection.z).toBeCloseTo(0);
    });
  });

  describe("normalizeAxis", () => {
    it("returns xAxis for 'x'", () => {
      const plane = Plane.XY();
      const axis = plane.normalizeAxis("x");
      expect(axis).toBe(plane.xAxis);
    });

    it("returns yAxis for 'y'", () => {
      const plane = Plane.XY();
      const axis = plane.normalizeAxis("y");
      expect(axis).toBe(plane.yAxis);
    });

    it("returns zAxis for 'z'", () => {
      const plane = Plane.XY();
      const axis = plane.normalizeAxis("z");
      expect(axis).toBe(plane.zAxis);
    });

    it("returns same axis for Axis input", () => {
      const plane = Plane.XY();
      const input = new Axis(Point.origin(), Vector3d.unitX());
      const axis = plane.normalizeAxis(input);
      expect(axis).toBe(input);
    });
  });

  describe("compareTo", () => {
    it("returns true for identical planes", () => {
      const p1 = Plane.XY();
      const p2 = Plane.XY();
      expect(p1.compareTo(p2)).toBe(true);
    });

    it("returns false for different planes", () => {
      const p1 = Plane.XY();
      const p2 = Plane.XY().offset(1);
      expect(p1.compareTo(p2)).toBe(false);
    });
  });

  describe("fromPointAndNormal", () => {
    it("creates plane from point and normal", () => {
      const point = new Point(1, 2, 3);
      const normal = Vector3d.unitZ();
      const plane = Plane.fromPointAndNormal(point, normal);
      expect(plane.origin.equals(point)).toBe(true);
      expect(plane.normal.z).toBeCloseTo(1);
    });
  });

  describe("fromThreePoints", () => {
    it("creates plane from three points", () => {
      const p1 = new Point(0, 0, 0);
      const p2 = new Point(1, 0, 0);
      const p3 = new Point(0, 1, 0);
      const plane = Plane.fromThreePoints(p1, p2, p3);
      expect(plane.origin.equals(p1)).toBe(true);
      expect(plane.normal.z).toBeCloseTo(1);
    });
  });

  describe("clone", () => {
    it("creates independent copy", () => {
      const plane = Plane.XY();
      const clone = plane.clone();
      expect(clone.compareTo(plane)).toBe(true);
      expect(clone).not.toBe(plane);
    });
  });
});

describe("helper functions", () => {
  describe("toPlane", () => {
    it("returns same instance for Plane", () => {
      const plane = Plane.XY();
      expect(toPlane(plane)).toBe(plane);
    });

    it("converts 'xy' to XY plane", () => {
      const plane = toPlane("xy");
      expect(plane.normal.z).toBeCloseTo(1);
    });

    it("converts 'top' to XY plane", () => {
      const plane = toPlane("top");
      expect(plane.normal.z).toBeCloseTo(1);
    });

    it("converts '-xy' to reversed XY plane", () => {
      const plane = toPlane("-xy");
      expect(plane.normal.z).toBeCloseTo(-1);
    });
  });

  describe("isPlaneLike", () => {
    it("returns true for Plane", () => {
      expect(isPlaneLike(Plane.XY())).toBe(true);
    });

    it("returns true for standard plane strings", () => {
      expect(isPlaneLike("xy")).toBe(true);
      expect(isPlaneLike("xz")).toBe(true);
      expect(isPlaneLike("yz")).toBe(true);
      expect(isPlaneLike("top")).toBe(true);
      expect(isPlaneLike("bottom")).toBe(true);
    });

    it("returns false for other values", () => {
      expect(isPlaneLike("abc")).toBe(false);
      expect(isPlaneLike(123)).toBe(false);
    });
  });
});
