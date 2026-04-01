import { describe, it, expect } from "vitest";
import { Matrix4 } from "../../math/matrix4.js";
import { Vector3d } from "../../math/vector3d.js";
import { Point } from "../../math/point.js";
import { Quaternion } from "../../math/quaternion.js";

describe("Matrix4", () => {
  describe("constructor", () => {
    it("creates identity matrix by default", () => {
      const m = new Matrix4();
      expect(m.get(0, 0)).toBe(1);
      expect(m.get(1, 1)).toBe(1);
      expect(m.get(2, 2)).toBe(1);
      expect(m.get(3, 3)).toBe(1);
      expect(m.get(0, 1)).toBe(0);
    });

    it("creates matrix from array", () => {
      const elements = [
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12,
        13, 14, 15, 16,
      ];
      const m = new Matrix4(elements);
      expect(m.get(0, 0)).toBe(1);
      expect(m.get(1, 0)).toBe(2);
      expect(m.get(0, 1)).toBe(5);
    });

    it("throws for wrong array length", () => {
      expect(() => new Matrix4([1, 2, 3])).toThrow();
    });
  });

  describe("identity", () => {
    it("returns identity matrix", () => {
      const m = Matrix4.identity();
      expect(m.get(0, 0)).toBe(1);
      expect(m.get(1, 1)).toBe(1);
      expect(m.get(2, 2)).toBe(1);
      expect(m.get(3, 3)).toBe(1);
    });
  });

  describe("multiply", () => {
    it("identity * M = M", () => {
      const m = Matrix4.fromTranslation(1, 2, 3);
      const result = Matrix4.identity().multiply(m);
      expect(result.equals(m)).toBe(true);
    });

    it("M * identity = M", () => {
      const m = Matrix4.fromTranslation(1, 2, 3);
      const result = m.multiply(Matrix4.identity());
      expect(result.equals(m)).toBe(true);
    });

    it("combines translations correctly", () => {
      const t1 = Matrix4.fromTranslation(1, 0, 0);
      const t2 = Matrix4.fromTranslation(0, 2, 0);
      const combined = t1.multiply(t2);
      const p = combined.transformPoint(Point.origin());
      expect(p.x).toBeCloseTo(1);
      expect(p.y).toBeCloseTo(2);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("determinant", () => {
    it("identity has determinant 1", () => {
      const m = Matrix4.identity();
      expect(m.determinant()).toBe(1);
    });

    it("scale matrix has determinant = product of scales", () => {
      const m = Matrix4.fromScale(2, 3, 4);
      expect(m.determinant()).toBeCloseTo(24);
    });
  });

  describe("inverse", () => {
    it("M * M^-1 = identity", () => {
      const m = Matrix4.fromTranslation(1, 2, 3);
      const inv = m.inverse();
      const result = m.multiply(inv);
      expect(result.equals(Matrix4.identity(), 1e-10)).toBe(true);
    });

    it("inverts rotation matrix", () => {
      const m = Matrix4.fromRotationZ(Math.PI / 4);
      const inv = m.inverse();
      const result = m.multiply(inv);
      expect(result.equals(Matrix4.identity(), 1e-10)).toBe(true);
    });

    it("inverts complex transformation", () => {
      const m = Matrix4.fromTranslation(1, 2, 3)
        .multiply(Matrix4.fromRotationY(Math.PI / 6))
        .multiply(Matrix4.fromScale(2, 2, 2));
      const inv = m.inverse();
      const result = m.multiply(inv);
      expect(result.equals(Matrix4.identity(), 1e-10)).toBe(true);
    });
  });

  describe("transpose", () => {
    it("swaps rows and columns", () => {
      const m = new Matrix4([
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12,
        13, 14, 15, 16,
      ]);
      const t = m.transpose();
      expect(t.get(0, 1)).toBe(m.get(1, 0));
      expect(t.get(1, 0)).toBe(m.get(0, 1));
    });

    it("double transpose returns original", () => {
      const m = Matrix4.fromRotationZ(Math.PI / 4);
      const result = m.transpose().transpose();
      expect(result.equals(m, 1e-10)).toBe(true);
    });
  });

  describe("fromTranslation", () => {
    it("creates translation matrix", () => {
      const m = Matrix4.fromTranslation(10, 20, 30);
      const p = m.transformPoint(Point.origin());
      expect(p.x).toBe(10);
      expect(p.y).toBe(20);
      expect(p.z).toBe(30);
    });

    it("does not affect vectors", () => {
      const m = Matrix4.fromTranslation(10, 20, 30);
      const v = m.transformVector(new Vector3d(1, 0, 0));
      expect(v.x).toBe(1);
      expect(v.y).toBe(0);
      expect(v.z).toBe(0);
    });
  });

  describe("fromScale", () => {
    it("creates scale matrix", () => {
      const m = Matrix4.fromScale(2, 3, 4);
      const p = m.transformPoint(new Point(1, 1, 1));
      expect(p.x).toBe(2);
      expect(p.y).toBe(3);
      expect(p.z).toBe(4);
    });

    it("scales vectors", () => {
      const m = Matrix4.fromScale(2, 3, 4);
      const v = m.transformVector(new Vector3d(1, 1, 1));
      expect(v.x).toBe(2);
      expect(v.y).toBe(3);
      expect(v.z).toBe(4);
    });
  });

  describe("fromUniformScale", () => {
    it("scales uniformly", () => {
      const m = Matrix4.fromUniformScale(3);
      const p = m.transformPoint(new Point(1, 2, 3));
      expect(p.x).toBe(3);
      expect(p.y).toBe(6);
      expect(p.z).toBe(9);
    });
  });

  describe("fromRotationX", () => {
    it("rotates around X axis", () => {
      const m = Matrix4.fromRotationX(Math.PI / 2);
      const p = m.transformPoint(new Point(0, 1, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(0);
      expect(p.z).toBeCloseTo(1);
    });
  });

  describe("fromRotationY", () => {
    it("rotates around Y axis", () => {
      const m = Matrix4.fromRotationY(Math.PI / 2);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(0);
      expect(p.z).toBeCloseTo(-1);
    });
  });

  describe("fromRotationZ", () => {
    it("rotates around Z axis", () => {
      const m = Matrix4.fromRotationZ(Math.PI / 2);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("fromAxisAngle", () => {
    it("rotates around arbitrary axis", () => {
      const m = Matrix4.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
      expect(p.z).toBeCloseTo(0);
    });

    it("rotates around diagonal axis", () => {
      const axis = new Vector3d(1, 1, 0).normalize();
      const m = Matrix4.fromAxisAngle(axis, Math.PI);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("fromQuaternion", () => {
    it("creates rotation matrix from quaternion", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const m = Matrix4.fromQuaternion(q);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("fromEulerAngles", () => {
    it("creates rotation from euler angles", () => {
      const m = Matrix4.fromEulerAngles(0, 0, Math.PI / 2);
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
      expect(p.z).toBeCloseTo(0);
    });
  });

  describe("mirrorPoint", () => {
    it("mirrors through a point", () => {
      const m = Matrix4.mirrorPoint(new Point(5, 0, 0));
      const p = m.transformPoint(new Point(3, 0, 0));
      expect(p.x).toBeCloseTo(7);
      expect(p.y).toBeCloseTo(0);
      expect(p.z).toBeCloseTo(0);
    });

    it("mirrors through origin", () => {
      const m = Matrix4.mirrorPoint(Point.origin());
      const p = m.transformPoint(new Point(1, 2, 3));
      expect(p.x).toBeCloseTo(-1);
      expect(p.y).toBeCloseTo(-2);
      expect(p.z).toBeCloseTo(-3);
    });
  });

  describe("mirrorPlane", () => {
    it("mirrors through XY plane", () => {
      const m = Matrix4.mirrorPlane(Vector3d.unitZ(), Point.origin());
      const p = m.transformPoint(new Point(1, 2, 3));
      expect(p.x).toBeCloseTo(1);
      expect(p.y).toBeCloseTo(2);
      expect(p.z).toBeCloseTo(-3);
    });

    it("mirrors through YZ plane", () => {
      const m = Matrix4.mirrorPlane(Vector3d.unitX(), Point.origin());
      const p = m.transformPoint(new Point(1, 2, 3));
      expect(p.x).toBeCloseTo(-1);
      expect(p.y).toBeCloseTo(2);
      expect(p.z).toBeCloseTo(3);
    });

    it("mirrors through offset plane", () => {
      const m = Matrix4.mirrorPlane(Vector3d.unitX(), new Point(5, 0, 0));
      const p = m.transformPoint(new Point(3, 0, 0));
      expect(p.x).toBeCloseTo(7);
    });
  });

  describe("mirrorAxis", () => {
    it("mirrors through Z axis", () => {
      const m = Matrix4.mirrorAxis(Point.origin(), Vector3d.unitZ());
      const p = m.transformPoint(new Point(1, 0, 0));
      expect(p.x).toBeCloseTo(-1);
      expect(p.y).toBeCloseTo(0);
      expect(p.z).toBeCloseTo(0);
    });

    it("mirrors through offset axis", () => {
      const m = Matrix4.mirrorAxis(new Point(5, 0, 0), Vector3d.unitZ());
      const p = m.transformPoint(new Point(3, 0, 0));
      expect(p.x).toBeCloseTo(7);
      expect(p.y).toBeCloseTo(0);
    });
  });

  describe("transformPoint", () => {
    it("applies translation", () => {
      const m = Matrix4.fromTranslation(10, 20, 30);
      const p = m.transformPoint(new Point(1, 2, 3));
      expect(p.x).toBe(11);
      expect(p.y).toBe(22);
      expect(p.z).toBe(33);
    });
  });

  describe("transformVector", () => {
    it("applies rotation but not translation", () => {
      const m = Matrix4.fromTranslation(10, 20, 30)
        .multiply(Matrix4.fromRotationZ(Math.PI / 2));
      const v = m.transformVector(new Vector3d(1, 0, 0));
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(1);
      expect(v.z).toBeCloseTo(0);
    });
  });

  describe("transformDirection", () => {
    it("returns normalized result", () => {
      const m = Matrix4.fromScale(2, 2, 2);
      const d = m.transformDirection(new Vector3d(1, 0, 0));
      expect(d.length()).toBeCloseTo(1);
    });
  });

  describe("decompose", () => {
    it("extracts translation", () => {
      const m = Matrix4.fromTranslation(1, 2, 3);
      const { translation } = m.decompose();
      expect(translation.x).toBeCloseTo(1);
      expect(translation.y).toBeCloseTo(2);
      expect(translation.z).toBeCloseTo(3);
    });

    it("extracts scale", () => {
      const m = Matrix4.fromScale(2, 3, 4);
      const { scale } = m.decompose();
      expect(scale.x).toBeCloseTo(2);
      expect(scale.y).toBeCloseTo(3);
      expect(scale.z).toBeCloseTo(4);
    });

    it("extracts rotation", () => {
      const m = Matrix4.fromRotationZ(Math.PI / 4);
      const { rotation } = m.decompose();
      const v = rotation.rotateVector(new Vector3d(1, 0, 0));
      expect(v.x).toBeCloseTo(Math.cos(Math.PI / 4));
      expect(v.y).toBeCloseTo(Math.sin(Math.PI / 4));
    });
  });

  describe("compose", () => {
    it("creates matrix from translation, rotation, scale", () => {
      const translation = new Vector3d(10, 20, 30);
      const rotation = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const scale = new Vector3d(2, 2, 2);

      const m = Matrix4.compose(translation, rotation, scale);
      const p = m.transformPoint(new Point(1, 0, 0));

      // First scale (1,0,0) -> (2,0,0)
      // Then rotate 90° around Z -> (0,2,0)
      // Then translate -> (10,22,30)
      expect(p.x).toBeCloseTo(10);
      expect(p.y).toBeCloseTo(22);
      expect(p.z).toBeCloseTo(30);
    });
  });

  describe("equals", () => {
    it("returns true for identical matrices", () => {
      const m1 = Matrix4.fromTranslation(1, 2, 3);
      const m2 = Matrix4.fromTranslation(1, 2, 3);
      expect(m1.equals(m2)).toBe(true);
    });

    it("returns false for different matrices", () => {
      const m1 = Matrix4.fromTranslation(1, 2, 3);
      const m2 = Matrix4.fromTranslation(1, 2, 4);
      expect(m1.equals(m2)).toBe(false);
    });

    it("supports tolerance", () => {
      const m1 = Matrix4.fromTranslation(1, 2, 3);
      const m2 = Matrix4.fromTranslation(1.001, 2.001, 3.001);
      expect(m1.equals(m2, 0.01)).toBe(true);
    });
  });

  describe("clone", () => {
    it("creates independent copy", () => {
      const m = Matrix4.fromTranslation(1, 2, 3);
      const clone = m.clone();
      expect(clone.equals(m)).toBe(true);
      expect(clone).not.toBe(m);
    });
  });
});
