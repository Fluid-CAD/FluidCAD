import { describe, it, expect } from "vitest";
import { Vector3d, normalizeVector } from "../../math/vector3d.js";

describe("Vector3d", () => {
  describe("constructor", () => {
    it("creates a vector with x, y, z components", () => {
      const v = new Vector3d(1, 2, 3);
      expect(v.x).toBe(1);
      expect(v.y).toBe(2);
      expect(v.z).toBe(3);
    });

  });

  describe("equals", () => {
    it("returns true for identical vectors", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(1, 2, 3);
      expect(v1.equals(v2)).toBe(true);
    });

    it("returns false for different vectors", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(1, 2, 4);
      expect(v1.equals(v2)).toBe(false);
    });

    it("supports tolerance", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(1.001, 2.001, 3.001);
      expect(v1.equals(v2, 0.01)).toBe(true);
      expect(v1.equals(v2, 0.0001)).toBe(false);
    });
  });

  describe("dot", () => {
    it("computes dot product correctly", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(4, 5, 6);
      expect(v1.dot(v2)).toBe(32); // 1*4 + 2*5 + 3*6
    });

    it("returns 0 for perpendicular vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(0, 1, 0);
      expect(v1.dot(v2)).toBe(0);
    });
  });

  describe("cross", () => {
    it("computes cross product correctly", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(0, 1, 0);
      const result = v1.cross(v2);
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.z).toBe(1);
    });

    it("returns zero vector for parallel vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(2, 0, 0);
      const result = v1.cross(v2);
      expect(result.isZero()).toBe(true);
    });
  });

  describe("length", () => {
    it("computes length correctly", () => {
      const v = new Vector3d(3, 4, 0);
      expect(v.length()).toBe(5);
    });

    it("returns 0 for zero vector", () => {
      const v = new Vector3d(0, 0, 0);
      expect(v.length()).toBe(0);
    });
  });

  describe("normalize", () => {
    it("returns unit vector", () => {
      const v = new Vector3d(3, 4, 0);
      const normalized = v.normalize();
      expect(normalized.length()).toBeCloseTo(1);
      expect(normalized.x).toBeCloseTo(0.6);
      expect(normalized.y).toBeCloseTo(0.8);
      expect(normalized.z).toBe(0);
    });

    it("throws for zero vector", () => {
      const v = new Vector3d(0, 0, 0);
      expect(() => v.normalize()).toThrow();
    });
  });

  describe("add", () => {
    it("adds vectors correctly", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(4, 5, 6);
      const result = v1.add(v2);
      expect(result.x).toBe(5);
      expect(result.y).toBe(7);
      expect(result.z).toBe(9);
    });

    it("is immutable", () => {
      const v1 = new Vector3d(1, 2, 3);
      const v2 = new Vector3d(4, 5, 6);
      v1.add(v2);
      expect(v1.x).toBe(1);
    });
  });

  describe("subtract", () => {
    it("subtracts vectors correctly", () => {
      const v1 = new Vector3d(4, 5, 6);
      const v2 = new Vector3d(1, 2, 3);
      const result = v1.subtract(v2);
      expect(result.x).toBe(3);
      expect(result.y).toBe(3);
      expect(result.z).toBe(3);
    });
  });

  describe("multiply", () => {
    it("multiplies by scalar correctly", () => {
      const v = new Vector3d(1, 2, 3);
      const result = v.multiply(2);
      expect(result.x).toBe(2);
      expect(result.y).toBe(4);
      expect(result.z).toBe(6);
    });
  });

  describe("negate", () => {
    it("negates vector correctly", () => {
      const v = new Vector3d(1, -2, 3);
      const result = v.negate();
      expect(result.x).toBe(-1);
      expect(result.y).toBe(2);
      expect(result.z).toBe(-3);
    });
  });

  describe("isZero", () => {
    it("returns true for zero vector", () => {
      const v = new Vector3d(0, 0, 0);
      expect(v.isZero()).toBe(true);
    });

    it("returns false for non-zero vector", () => {
      const v = new Vector3d(0.001, 0, 0);
      expect(v.isZero()).toBe(false);
    });

    it("supports tolerance", () => {
      const v = new Vector3d(0.001, 0.001, 0.001);
      expect(v.isZero(0.01)).toBe(true);
    });
  });

  describe("angleTo", () => {
    it("returns 0 for same direction", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(2, 0, 0);
      expect(v1.angleTo(v2)).toBeCloseTo(0);
    });

    it("returns PI/2 for perpendicular vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(0, 1, 0);
      expect(v1.angleTo(v2)).toBeCloseTo(Math.PI / 2);
    });

    it("returns PI for opposite directions", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(-1, 0, 0);
      expect(v1.angleTo(v2)).toBeCloseTo(Math.PI);
    });
  });

  describe("projectOnto", () => {
    it("projects vector correctly", () => {
      const v = new Vector3d(3, 4, 0);
      const onto = new Vector3d(1, 0, 0);
      const result = v.projectOnto(onto);
      expect(result.x).toBeCloseTo(3);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(0);
    });
  });

  describe("reflect", () => {
    it("reflects vector correctly", () => {
      const v = new Vector3d(1, -1, 0);
      const normal = new Vector3d(0, 1, 0);
      const result = v.reflect(normal);
      expect(result.x).toBeCloseTo(1);
      expect(result.y).toBeCloseTo(1);
      expect(result.z).toBeCloseTo(0);
    });
  });

  describe("lerp", () => {
    it("interpolates at t=0", () => {
      const v1 = new Vector3d(0, 0, 0);
      const v2 = new Vector3d(10, 10, 10);
      const result = v1.lerp(v2, 0);
      expect(result.equals(v1)).toBe(true);
    });

    it("interpolates at t=1", () => {
      const v1 = new Vector3d(0, 0, 0);
      const v2 = new Vector3d(10, 10, 10);
      const result = v1.lerp(v2, 1);
      expect(result.equals(v2)).toBe(true);
    });

    it("interpolates at t=0.5", () => {
      const v1 = new Vector3d(0, 0, 0);
      const v2 = new Vector3d(10, 10, 10);
      const result = v1.lerp(v2, 0.5);
      expect(result.x).toBe(5);
      expect(result.y).toBe(5);
      expect(result.z).toBe(5);
    });
  });

  describe("isParallelTo", () => {
    it("returns true for parallel vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(5, 0, 0);
      expect(v1.isParallelTo(v2)).toBe(true);
    });

    it("returns true for anti-parallel vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(-5, 0, 0);
      expect(v1.isParallelTo(v2)).toBe(true);
    });

    it("returns false for non-parallel vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(1, 1, 0);
      expect(v1.isParallelTo(v2)).toBe(false);
    });
  });

  describe("isPerpendicularTo", () => {
    it("returns true for perpendicular vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(0, 1, 0);
      expect(v1.isPerpendicularTo(v2)).toBe(true);
    });

    it("returns false for non-perpendicular vectors", () => {
      const v1 = new Vector3d(1, 0, 0);
      const v2 = new Vector3d(1, 1, 0);
      expect(v1.isPerpendicularTo(v2)).toBe(false);
    });
  });

  describe("static methods", () => {
    it("unitX returns (1,0,0)", () => {
      const v = Vector3d.unitX();
      expect(v.x).toBe(1);
      expect(v.y).toBe(0);
      expect(v.z).toBe(0);
    });

    it("unitY returns (0,1,0)", () => {
      const v = Vector3d.unitY();
      expect(v.x).toBe(0);
      expect(v.y).toBe(1);
      expect(v.z).toBe(0);
    });

    it("unitZ returns (0,0,1)", () => {
      const v = Vector3d.unitZ();
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
      expect(v.z).toBe(1);
    });

    it("zero returns (0,0,0)", () => {
      const v = Vector3d.zero();
      expect(v.isZero()).toBe(true);
    });

    it("fromArray creates vector from array", () => {
      const v = Vector3d.fromArray([1, 2, 3]);
      expect(v.x).toBe(1);
      expect(v.y).toBe(2);
      expect(v.z).toBe(3);
    });
  });

  describe("toVector3d helper", () => {
    it("returns same instance for Vector3d", () => {
      const v = new Vector3d(1, 2, 3);
      expect(normalizeVector(v)).toBe(v);
    });

    it("converts array to Vector3d", () => {
      const v = normalizeVector([1, 2, 3]);
      expect(v.x).toBe(1);
      expect(v.y).toBe(2);
      expect(v.z).toBe(3);
    });

    it("converts object to Vector3d", () => {
      const v = normalizeVector({ x: 1, y: 2, z: 3 });
      expect(v.x).toBe(1);
      expect(v.y).toBe(2);
      expect(v.z).toBe(3);
    });
  });
});
