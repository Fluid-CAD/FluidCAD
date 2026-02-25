import { describe, it, expect } from "vitest";
import { Axis, toAxis, isAxisLike } from "./axis.js";
import { Point } from "./point.js";
import { Vector3d } from "./vector3d.js";

describe("Axis", () => {
  describe("constructor", () => {
    it("creates axis with origin and direction", () => {
      const origin = new Point(1, 2, 3);
      const direction = new Vector3d(0, 0, 1);
      const axis = new Axis(origin, direction);
      expect(axis.origin.equals(origin)).toBe(true);
      expect(axis.direction.equals(direction)).toBe(true);
    });
  });

  describe("static axes", () => {
    it("X returns X axis at origin", () => {
      const axis = Axis.X();
      expect(axis.origin.equals(Point.origin())).toBe(true);
      expect(axis.direction.equals(Vector3d.unitX())).toBe(true);
    });

    it("Y returns Y axis at origin", () => {
      const axis = Axis.Y();
      expect(axis.origin.equals(Point.origin())).toBe(true);
      expect(axis.direction.equals(Vector3d.unitY())).toBe(true);
    });

    it("Z returns Z axis at origin", () => {
      const axis = Axis.Z();
      expect(axis.origin.equals(Point.origin())).toBe(true);
      expect(axis.direction.equals(Vector3d.unitZ())).toBe(true);
    });
  });

  describe("equals", () => {
    it("returns true for identical axes", () => {
      const a1 = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      const a2 = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      expect(a1.equals(a2)).toBe(true);
    });

    it("returns false for different origin", () => {
      const a1 = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      const a2 = new Axis(new Point(1, 2, 4), new Vector3d(0, 0, 1));
      expect(a1.equals(a2)).toBe(false);
    });

    it("returns false for different direction", () => {
      const a1 = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      const a2 = new Axis(new Point(1, 2, 3), new Vector3d(0, 1, 0));
      expect(a1.equals(a2)).toBe(false);
    });

    it("supports tolerance", () => {
      const a1 = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      const a2 = new Axis(new Point(1.001, 2.001, 3.001), new Vector3d(0, 0, 1));
      expect(a1.equals(a2, 0.01)).toBe(true);
    });
  });

  describe("translate", () => {
    it("translates origin, keeps direction", () => {
      const axis = Axis.Z();
      const translated = axis.translate(1, 2, 3);
      expect(translated.origin.x).toBe(1);
      expect(translated.origin.y).toBe(2);
      expect(translated.origin.z).toBe(3);
      expect(translated.direction.equals(Vector3d.unitZ())).toBe(true);
    });
  });

  describe("translateVector", () => {
    it("translates by vector", () => {
      const axis = Axis.Z();
      const translated = axis.translateVector(new Vector3d(1, 2, 3));
      expect(translated.origin.x).toBe(1);
      expect(translated.origin.y).toBe(2);
      expect(translated.origin.z).toBe(3);
    });
  });

  describe("rotateX/Y/Z", () => {
    it("rotateX rotates around world X axis", () => {
      const axis = new Axis(Point.origin(), Vector3d.unitY());
      const rotated = axis.rotateX(Math.PI / 2);
      expect(rotated.direction.x).toBeCloseTo(0);
      expect(rotated.direction.y).toBeCloseTo(0);
      expect(rotated.direction.z).toBeCloseTo(1);
    });

    it("rotateY rotates around world Y axis", () => {
      const axis = new Axis(Point.origin(), Vector3d.unitX());
      const rotated = axis.rotateY(Math.PI / 2);
      expect(rotated.direction.x).toBeCloseTo(0);
      expect(rotated.direction.y).toBeCloseTo(0);
      expect(rotated.direction.z).toBeCloseTo(-1);
    });

    it("rotateZ rotates around world Z axis", () => {
      const axis = new Axis(Point.origin(), Vector3d.unitX());
      const rotated = axis.rotateZ(Math.PI / 2);
      expect(rotated.direction.x).toBeCloseTo(0);
      expect(rotated.direction.y).toBeCloseTo(1);
      expect(rotated.direction.z).toBeCloseTo(0);
    });
  });

  describe("rotateAroundAxis", () => {
    it("rotates around another axis", () => {
      const axis = new Axis(new Point(1, 0, 0), Vector3d.unitY());
      const rotateAround = Axis.Z();
      const rotated = axis.rotateAroundAxis(rotateAround, Math.PI / 2);
      expect(rotated.origin.x).toBeCloseTo(0);
      expect(rotated.origin.y).toBeCloseTo(1);
      expect(rotated.origin.z).toBeCloseTo(0);
    });
  });

  describe("transform", () => {
    it("applies offset", () => {
      const axis = Axis.Z();
      const transformed = axis.transform({ offsetX: 1, offsetY: 2, offsetZ: 3 });
      expect(transformed.origin.x).toBe(1);
      expect(transformed.origin.y).toBe(2);
      expect(transformed.origin.z).toBe(3);
    });

    it("applies rotation without gimbal lock", () => {
      const axis = new Axis(Point.origin(), Vector3d.unitX());
      // Apply 90° Y rotation - this would cause gimbal lock with sequential rotations
      const transformed = axis.transform({ rotateY: Math.PI / 2 });
      expect(transformed.direction.x).toBeCloseTo(0);
      expect(transformed.direction.z).toBeCloseTo(-1);
    });

    it("combines offset and rotation", () => {
      const axis = new Axis(Point.origin(), Vector3d.unitX());
      const transformed = axis.transform({
        offsetX: 5,
        rotateZ: Math.PI / 2,
      });
      expect(transformed.origin.x).toBe(5);
      expect(transformed.direction.x).toBeCloseTo(0);
      expect(transformed.direction.y).toBeCloseTo(1);
    });
  });

  describe("isParallelTo", () => {
    it("returns true for parallel axes", () => {
      const a1 = new Axis(new Point(0, 0, 0), Vector3d.unitZ());
      const a2 = new Axis(new Point(5, 5, 0), Vector3d.unitZ());
      expect(a1.isParallelTo(a2)).toBe(true);
    });

    it("returns true for anti-parallel axes", () => {
      const a1 = new Axis(Point.origin(), Vector3d.unitZ());
      const a2 = new Axis(Point.origin(), Vector3d.unitZ().negate());
      expect(a1.isParallelTo(a2)).toBe(true);
    });

    it("returns false for non-parallel axes", () => {
      const a1 = new Axis(Point.origin(), Vector3d.unitZ());
      const a2 = new Axis(Point.origin(), Vector3d.unitX());
      expect(a1.isParallelTo(a2)).toBe(false);
    });
  });

  describe("isPerpendicularTo", () => {
    it("returns true for perpendicular axes", () => {
      const a1 = Axis.X();
      const a2 = Axis.Y();
      expect(a1.isPerpendicularTo(a2)).toBe(true);
    });

    it("returns false for non-perpendicular axes", () => {
      const a1 = Axis.X();
      const a2 = new Axis(Point.origin(), new Vector3d(1, 1, 0));
      expect(a1.isPerpendicularTo(a2)).toBe(false);
    });
  });

  describe("distanceToPoint", () => {
    it("returns 0 for point on axis", () => {
      const axis = Axis.Z();
      const point = new Point(0, 0, 5);
      expect(axis.distanceToPoint(point)).toBeCloseTo(0);
    });

    it("returns perpendicular distance", () => {
      const axis = Axis.Z();
      const point = new Point(3, 4, 0);
      expect(axis.distanceToPoint(point)).toBeCloseTo(5);
    });
  });

  describe("closestPointOnAxis", () => {
    it("returns closest point", () => {
      const axis = Axis.Z();
      const point = new Point(3, 4, 5);
      const closest = axis.closestPointOnAxis(point);
      expect(closest.x).toBeCloseTo(0);
      expect(closest.y).toBeCloseTo(0);
      expect(closest.z).toBeCloseTo(5);
    });
  });

  describe("pointAtParameter", () => {
    it("returns point at parameter t", () => {
      const axis = new Axis(new Point(1, 0, 0), Vector3d.unitX());
      const p = axis.pointAtParameter(5);
      expect(p.x).toBe(6);
      expect(p.y).toBe(0);
      expect(p.z).toBe(0);
    });
  });

  describe("reverse", () => {
    it("reverses direction", () => {
      const axis = Axis.Z();
      const reversed = axis.reverse();
      expect(reversed.direction.z).toBe(-1);
      expect(reversed.origin.equals(axis.origin)).toBe(true);
    });
  });

  describe("mirror methods", () => {
    it("mirrorAroundPoint mirrors through point", () => {
      const axis = new Axis(new Point(2, 0, 0), Vector3d.unitZ());
      const mirrored = axis.mirrorAroundPoint(Point.origin());
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });

    it("mirrorAroundPlane mirrors through plane", () => {
      const axis = new Axis(new Point(0, 0, 2), Vector3d.unitZ());
      const mirrored = axis.mirrorAroundPlane(Vector3d.unitZ(), Point.origin());
      expect(mirrored.origin.z).toBeCloseTo(-2);
      expect(mirrored.direction.z).toBeCloseTo(-1);
    });

    it("mirrorAroundAxis mirrors through axis", () => {
      const axis = new Axis(new Point(2, 0, 0), Vector3d.unitY());
      const mirrorAxis = Axis.Z();
      const mirrored = axis.mirrorAroundAxis(mirrorAxis);
      expect(mirrored.origin.x).toBeCloseTo(-2);
    });
  });

  describe("fromPoints", () => {
    it("creates axis from two points", () => {
      const start = new Point(0, 0, 0);
      const end = new Point(0, 0, 5);
      const axis = Axis.fromPoints(start, end);
      expect(axis.origin.equals(start)).toBe(true);
      expect(axis.direction.equals(Vector3d.unitZ())).toBe(true);
    });
  });

  describe("serialize/deserialize", () => {
    it("serializes to object", () => {
      const axis = new Axis(new Point(1, 2, 3), new Vector3d(0, 0, 1));
      const data = axis.serialize();
      expect(data.origin).toEqual({ x: 1, y: 2, z: 3 });
      expect(data.direction).toEqual({ x: 0, y: 0, z: 1 });
    });

    it("deserializes from object", () => {
      const data = {
        origin: { x: 1, y: 2, z: 3 },
        direction: { x: 0, y: 0, z: 1 },
      };
      const axis = Axis.deserialize(data);
      expect(axis.origin.x).toBe(1);
      expect(axis.direction.z).toBe(1);
    });
  });

  describe("clone", () => {
    it("creates independent copy", () => {
      const axis = new Axis(new Point(1, 2, 3), Vector3d.unitZ());
      const clone = axis.clone();
      expect(clone.equals(axis)).toBe(true);
      expect(clone).not.toBe(axis);
    });
  });
});

describe("helper functions", () => {
  describe("toAxis", () => {
    it("returns same instance for Axis", () => {
      const axis = Axis.Z();
      expect(toAxis(axis)).toBe(axis);
    });

    it("converts 'x' to X axis", () => {
      const axis = toAxis("x");
      expect(axis.direction.equals(Vector3d.unitX())).toBe(true);
    });

    it("converts 'y' to Y axis", () => {
      const axis = toAxis("y");
      expect(axis.direction.equals(Vector3d.unitY())).toBe(true);
    });

    it("converts 'z' to Z axis", () => {
      const axis = toAxis("z");
      expect(axis.direction.equals(Vector3d.unitZ())).toBe(true);
    });
  });

  describe("isAxisLike", () => {
    it("returns true for Axis", () => {
      expect(isAxisLike(Axis.Z())).toBe(true);
    });

    it("returns true for 'x', 'y', 'z'", () => {
      expect(isAxisLike("x")).toBe(true);
      expect(isAxisLike("y")).toBe(true);
      expect(isAxisLike("z")).toBe(true);
    });

    it("returns false for other values", () => {
      expect(isAxisLike("w")).toBe(false);
      expect(isAxisLike(123)).toBe(false);
    });
  });
});
