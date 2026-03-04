import { describe, it, expect } from "vitest";
import { Point, Point2D, isPointLike, isPoint2DLike } from "./point.js";
import { Vector3d } from "./vector3d.js";
import { Axis } from "./axis.js";

describe("Point", () => {
  describe("constructor", () => {
    it("creates a point with x, y, z coordinates", () => {
      const p = new Point(1, 2, 3);
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
      expect(p.z).toBe(3);
    });

  });

  describe("equals", () => {
    it("returns true for identical points", () => {
      const p1 = new Point(1, 2, 3);
      const p2 = new Point(1, 2, 3);
      expect(p1.equals(p2)).toBe(true);
    });

    it("returns false for different points", () => {
      const p1 = new Point(1, 2, 3);
      const p2 = new Point(1, 2, 4);
      expect(p1.equals(p2)).toBe(false);
    });

    it("supports tolerance", () => {
      const p1 = new Point(1, 2, 3);
      const p2 = new Point(1.001, 2.001, 3.001);
      expect(p1.equals(p2, 0.01)).toBe(true);
      expect(p1.equals(p2, 0.0001)).toBe(false);
    });
  });

  describe("distanceTo", () => {
    it("computes distance to another point", () => {
      const p1 = new Point(0, 0, 0);
      const p2 = new Point(3, 4, 0);
      expect(p1.distanceTo(p2)).toBe(5);
    });

    it("computes distance to a vector", () => {
      const p = new Point(0, 0, 0);
      const v = new Vector3d(3, 4, 0);
      expect(p.distanceTo(v)).toBe(5);
    });

    it("returns 0 for same point", () => {
      const p1 = new Point(1, 2, 3);
      const p2 = new Point(1, 2, 3);
      expect(p1.distanceTo(p2)).toBe(0);
    });
  });

  describe("add", () => {
    it("adds a vector to point", () => {
      const p = new Point(1, 2, 3);
      const v = new Vector3d(4, 5, 6);
      const result = p.add(v);
      expect(result.x).toBe(5);
      expect(result.y).toBe(7);
      expect(result.z).toBe(9);
    });

    it("is immutable", () => {
      const p = new Point(1, 2, 3);
      const v = new Vector3d(4, 5, 6);
      p.add(v);
      expect(p.x).toBe(1);
    });
  });

  describe("subtract", () => {
    it("subtracts a vector from point", () => {
      const p = new Point(5, 7, 9);
      const v = new Vector3d(1, 2, 3);
      const result = p.subtract(v);
      expect(result.x).toBe(4);
      expect(result.y).toBe(5);
      expect(result.z).toBe(6);
    });
  });

  describe("multiply", () => {
    it("multiplies point by scalar", () => {
      const p = new Point(1, 2, 3);
      const result = p.multiplyScalar(2);
      expect(result.x).toBe(2);
      expect(result.y).toBe(4);
      expect(result.z).toBe(6);
    });
  });

  describe("translate", () => {
    it("translates point by dx, dy, dz", () => {
      const p = new Point(1, 2, 3);
      const result = p.translate(10, 20, 30);
      expect(result.x).toBe(11);
      expect(result.y).toBe(22);
      expect(result.z).toBe(33);
    });

    it("defaults dz to 0", () => {
      const p = new Point(1, 2, 3);
      const result = p.translate(10, 20);
      expect(result.z).toBe(3);
    });
  });

  describe("translateX/Y/Z", () => {
    it("translateX moves along X axis", () => {
      const p = new Point(1, 2, 3);
      const result = p.translateX(10);
      expect(result.x).toBe(11);
      expect(result.y).toBe(2);
      expect(result.z).toBe(3);
    });

    it("translateY moves along Y axis", () => {
      const p = new Point(1, 2, 3);
      const result = p.translateY(10);
      expect(result.x).toBe(1);
      expect(result.y).toBe(12);
      expect(result.z).toBe(3);
    });

    it("translateZ moves along Z axis", () => {
      const p = new Point(1, 2, 3);
      const result = p.translateZ(10);
      expect(result.x).toBe(1);
      expect(result.y).toBe(2);
      expect(result.z).toBe(13);
    });
  });

  describe("vectorTo", () => {
    it("returns vector from this point to another", () => {
      const p1 = new Point(1, 2, 3);
      const p2 = new Point(4, 6, 8);
      const v = p1.vectorTo(p2);
      expect(v.x).toBe(3);
      expect(v.y).toBe(4);
      expect(v.z).toBe(5);
    });
  });

  describe("lerp", () => {
    it("interpolates between points", () => {
      const p1 = new Point(0, 0, 0);
      const p2 = new Point(10, 10, 10);
      const result = p1.lerp(p2, 0.5);
      expect(result.x).toBe(5);
      expect(result.y).toBe(5);
      expect(result.z).toBe(5);
    });
  });

  describe("toVector3d", () => {
    it("converts point to vector", () => {
      const p = new Point(1, 2, 3);
      const v = p.toVector3d();
      expect(v).toBeInstanceOf(Vector3d);
      expect(v.x).toBe(1);
      expect(v.y).toBe(2);
      expect(v.z).toBe(3);
    });
  });

  describe("toPoint2D", () => {
    it("converts to Point2D (drops z)", () => {
      const p = new Point(1, 2, 3);
      const p2d = p.toPoint2D();
      expect(p2d).toBeInstanceOf(Point2D);
      expect(p2d.x).toBe(1);
      expect(p2d.y).toBe(2);
    });
  });

  describe("static methods", () => {
    it("origin returns (0,0,0)", () => {
      const p = Point.origin();
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
      expect(p.z).toBe(0);
    });

    it("fromArray creates point from array", () => {
      const p = Point.fromArray([1, 2, 3]);
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
      expect(p.z).toBe(3);
    });

    it("fromVector3d creates point from vector", () => {
      const v = new Vector3d(1, 2, 3);
      const p = Point.fromVector3d(v);
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
      expect(p.z).toBe(3);
    });
  });
});

describe("Point2D", () => {
  describe("constructor", () => {
    it("creates a point with x, y coordinates", () => {
      const p = new Point2D(1, 2);
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
    });
  });

  describe("equals", () => {
    it("returns true for identical points", () => {
      const p1 = new Point2D(1, 2);
      const p2 = new Point2D(1, 2);
      expect(p1.equals(p2)).toBe(true);
    });

    it("supports tolerance", () => {
      const p1 = new Point2D(1, 2);
      const p2 = new Point2D(1.001, 2.001);
      expect(p1.equals(p2, 0.01)).toBe(true);
    });
  });

  describe("distanceTo", () => {
    it("computes distance correctly", () => {
      const p1 = new Point2D(0, 0);
      const p2 = new Point2D(3, 4);
      expect(p1.distanceTo(p2)).toBe(5);
    });
  });

  describe("add/subtract", () => {
    it("adds points correctly", () => {
      const p1 = new Point2D(1, 2);
      const p2 = new Point2D(3, 4);
      const result = p1.add(p2);
      expect(result.x).toBe(4);
      expect(result.y).toBe(6);
    });

    it("subtracts points correctly", () => {
      const p1 = new Point2D(5, 7);
      const p2 = new Point2D(2, 3);
      const result = p1.subtract(p2);
      expect(result.x).toBe(3);
      expect(result.y).toBe(4);
    });
  });

  describe("multiply", () => {
    it("multiplies component-wise", () => {
      const p1 = new Point2D(2, 3);
      const p2 = new Point2D(4, 5);
      const result = p1.multiply(p2);
      expect(result.x).toBe(8);
      expect(result.y).toBe(15);
    });
  });

  describe("multiplyScalar", () => {
    it("multiplies by scalar", () => {
      const p = new Point2D(2, 3);
      const result = p.multiplyScalar(2);
      expect(result.x).toBe(4);
      expect(result.y).toBe(6);
    });
  });

  describe("normalize", () => {
    it("returns unit vector", () => {
      const p = new Point2D(3, 4);
      const result = p.normalize();
      expect(result.length()).toBeCloseTo(1);
    });

    it("returns zero for zero point", () => {
      const p = new Point2D(0, 0);
      const result = p.normalize();
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });
  });

  describe("rotate", () => {
    it("rotates around origin", () => {
      const p = new Point2D(1, 0);
      const result = p.rotate(Math.PI / 2);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(1);
    });

    it("rotates around custom pivot", () => {
      const p = new Point2D(2, 0);
      const pivot = new Point2D(1, 0);
      const result = p.rotate(Math.PI / 2, pivot);
      expect(result.x).toBeCloseTo(1);
      expect(result.y).toBeCloseTo(1);
    });
  });

  describe("toPoint", () => {
    it("converts to Point with z=0 by default", () => {
      const p2d = new Point2D(1, 2);
      const p = p2d.toPoint();
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
      expect(p.z).toBe(0);
    });

    it("converts to Point with custom z", () => {
      const p2d = new Point2D(1, 2);
      const p = p2d.toPoint(5);
      expect(p.z).toBe(5);
    });
  });

  describe("mirrorAroundPoint", () => {
    it("mirrors point around origin", () => {
      const p = new Point2D(2, 3);
      const result = p.mirrorAroundPoint(Point2D.origin());
      expect(result.x).toBe(-2);
      expect(result.y).toBe(-3);
    });

    it("mirrors point around arbitrary pivot", () => {
      const p = new Point2D(4, 2);
      const pivot = new Point2D(2, 2);
      const result = p.mirrorAroundPoint(pivot);
      expect(result.x).toBe(0);
      expect(result.y).toBe(2);
    });

    it("returns same point when mirroring around itself", () => {
      const p = new Point2D(1, 1);
      const result = p.mirrorAroundPoint(p);
      expect(result.x).toBe(1);
      expect(result.y).toBe(1);
    });
  });

  describe("mirrorAroundAxis", () => {
    it("mirrors point around Y-axis", () => {
      const p = new Point2D(2, 3);
      const yAxis = new Axis(Point.origin(), new Vector3d(0, 1, 0));
      const result = p.mirrorAroundAxis(yAxis);
      expect(result.x).toBeCloseTo(-2);
      expect(result.y).toBeCloseTo(3);
    });

    it("mirrors point around X-axis", () => {
      const p = new Point2D(2, 3);
      const xAxis = new Axis(Point.origin(), new Vector3d(1, 0, 0));
      const result = p.mirrorAroundAxis(xAxis);
      expect(result.x).toBeCloseTo(2);
      expect(result.y).toBeCloseTo(-3);
    });

    it("mirrors point around diagonal axis (y=x)", () => {
      const p = new Point2D(1, 0);
      const diagonalAxis = new Axis(Point.origin(), new Vector3d(1, 1, 0));
      const result = p.mirrorAroundAxis(diagonalAxis);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(1);
    });

    it("point on axis remains unchanged", () => {
      const p = new Point2D(2, 2);
      const diagonalAxis = new Axis(Point.origin(), new Vector3d(1, 1, 0));
      const result = p.mirrorAroundAxis(diagonalAxis);
      expect(result.x).toBeCloseTo(2);
      expect(result.y).toBeCloseTo(2);
    });

    it("mirrors around offset axis", () => {
      const p = new Point2D(3, 1);
      // Vertical axis at x=2
      const axis = new Axis(new Point(2, 0, 0), new Vector3d(0, 1, 0));
      const result = p.mirrorAroundAxis(axis);
      expect(result.x).toBeCloseTo(1);
      expect(result.y).toBeCloseTo(1);
    });
  });

  describe("static methods", () => {
    it("origin returns (0,0)", () => {
      const p = Point2D.origin();
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
    });

    it("fromArray creates point from array", () => {
      const p = Point2D.fromArray([1, 2]);
      expect(p.x).toBe(1);
      expect(p.y).toBe(2);
    });
  });
});

describe("helper functions", () => {
  describe("isPointLike", () => {
    it("returns true for Point", () => {
      expect(isPointLike(new Point(1, 2, 3))).toBe(true);
    });

    it("returns true for array of 3", () => {
      expect(isPointLike([1, 2, 3])).toBe(true);
    });

    it("returns true for object with x,y,z", () => {
      expect(isPointLike({ x: 1, y: 2, z: 3 })).toBe(true);
    });

    it("returns false for Point2D", () => {
      expect(isPointLike(new Point2D(1, 2))).toBe(false);
    });
  });

  describe("isPoint2DLike", () => {
    it("returns true for Point2D", () => {
      expect(isPoint2DLike(new Point2D(1, 2))).toBe(true);
    });

    it("returns true for array of 2", () => {
      expect(isPoint2DLike([1, 2])).toBe(true);
    });

    it("returns true for object with x,y only", () => {
      expect(isPoint2DLike({ x: 1, y: 2 })).toBe(true);
    });

    it("returns false for Point", () => {
      expect(isPoint2DLike(new Point(1, 2, 3))).toBe(false);
    });
  });
});
