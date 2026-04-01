import { describe, it, expect } from "vitest";
import { Quaternion } from "../../math/quaternion.js";
import { Vector3d } from "../../math/vector3d.js";

describe("Quaternion", () => {
  describe("constructor", () => {
    it("creates quaternion with x, y, z, w components", () => {
      const q = new Quaternion(1, 2, 3, 4);
      expect(q.x).toBe(1);
      expect(q.y).toBe(2);
      expect(q.z).toBe(3);
      expect(q.w).toBe(4);
    });
  });

  describe("identity", () => {
    it("returns identity quaternion (0,0,0,1)", () => {
      const q = Quaternion.identity();
      expect(q.x).toBe(0);
      expect(q.y).toBe(0);
      expect(q.z).toBe(0);
      expect(q.w).toBe(1);
    });
  });

  describe("length", () => {
    it("computes length correctly", () => {
      const q = new Quaternion(1, 2, 2, 0);
      expect(q.length()).toBe(3);
    });

    it("identity has length 1", () => {
      const q = Quaternion.identity();
      expect(q.length()).toBe(1);
    });
  });

  describe("normalize", () => {
    it("returns unit quaternion", () => {
      const q = new Quaternion(1, 2, 3, 4);
      const normalized = q.normalize();
      expect(normalized.length()).toBeCloseTo(1);
    });

    it("returns identity for zero quaternion", () => {
      const q = new Quaternion(0, 0, 0, 0);
      const normalized = q.normalize();
      expect(normalized.w).toBe(1);
    });
  });

  describe("conjugate", () => {
    it("negates xyz, keeps w", () => {
      const q = new Quaternion(1, 2, 3, 4);
      const conj = q.conjugate();
      expect(conj.x).toBe(-1);
      expect(conj.y).toBe(-2);
      expect(conj.z).toBe(-3);
      expect(conj.w).toBe(4);
    });
  });

  describe("inverse", () => {
    it("returns inverse quaternion", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 4);
      const inv = q.inverse();
      const result = q.multiply(inv);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(0);
      expect(result.w).toBeCloseTo(1);
    });
  });

  describe("multiply", () => {
    it("identity * q = q", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 4);
      const result = Quaternion.identity().multiply(q);
      expect(result.equals(q, 1e-10)).toBe(true);
    });

    it("q * identity = q", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 4);
      const result = q.multiply(Quaternion.identity());
      expect(result.equals(q, 1e-10)).toBe(true);
    });

    it("combines rotations correctly", () => {
      const q1 = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const q2 = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const combined = q1.multiply(q2);

      // Combined should be 180 degree rotation around Z
      const v = new Vector3d(1, 0, 0);
      const rotated = combined.rotateVector(v);
      expect(rotated.x).toBeCloseTo(-1);
      expect(rotated.y).toBeCloseTo(0);
      expect(rotated.z).toBeCloseTo(0);
    });
  });

  describe("rotateVector", () => {
    it("rotates vector around Z axis", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const v = new Vector3d(1, 0, 0);
      const result = q.rotateVector(v);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(1);
      expect(result.z).toBeCloseTo(0);
    });

    it("rotates vector around X axis", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitX(), Math.PI / 2);
      const v = new Vector3d(0, 1, 0);
      const result = q.rotateVector(v);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(1);
    });

    it("rotates vector around Y axis", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitY(), Math.PI / 2);
      const v = new Vector3d(1, 0, 0);
      const result = q.rotateVector(v);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(-1);
    });

    it("identity does not rotate", () => {
      const q = Quaternion.identity();
      const v = new Vector3d(1, 2, 3);
      const result = q.rotateVector(v);
      expect(result.x).toBeCloseTo(1);
      expect(result.y).toBeCloseTo(2);
      expect(result.z).toBeCloseTo(3);
    });
  });

  describe("fromAxisAngle", () => {
    it("creates quaternion from axis and angle", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI);
      const v = new Vector3d(1, 0, 0);
      const rotated = q.rotateVector(v);
      expect(rotated.x).toBeCloseTo(-1);
      expect(rotated.y).toBeCloseTo(0);
    });

    it("zero angle gives identity", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), 0);
      expect(q.x).toBeCloseTo(0);
      expect(q.y).toBeCloseTo(0);
      expect(q.z).toBeCloseTo(0);
      expect(q.w).toBeCloseTo(1);
    });
  });

  describe("toAxisAngle", () => {
    it("extracts axis and angle", () => {
      const axis = new Vector3d(0, 0, 1);
      const angle = Math.PI / 3;
      const q = Quaternion.fromAxisAngle(axis, angle);
      const result = q.toAxisAngle();
      expect(result.angle).toBeCloseTo(angle);
      expect(result.axis.x).toBeCloseTo(0);
      expect(result.axis.y).toBeCloseTo(0);
      expect(result.axis.z).toBeCloseTo(1);
    });

    it("handles identity quaternion", () => {
      const q = Quaternion.identity();
      const result = q.toAxisAngle();
      expect(result.angle).toBeCloseTo(0);
    });
  });

  describe("fromEulerAngles", () => {
    it("creates quaternion from euler angles", () => {
      const q = Quaternion.fromEulerAngles(0, 0, Math.PI / 2);
      const v = new Vector3d(1, 0, 0);
      const rotated = q.rotateVector(v);
      expect(rotated.x).toBeCloseTo(0);
      expect(rotated.y).toBeCloseTo(1);
      expect(rotated.z).toBeCloseTo(0);
    });

    it("zero angles give identity", () => {
      const q = Quaternion.fromEulerAngles(0, 0, 0);
      expect(q.w).toBeCloseTo(1);
      expect(q.x).toBeCloseTo(0);
      expect(q.y).toBeCloseTo(0);
      expect(q.z).toBeCloseTo(0);
    });
  });

  describe("toEulerAngles", () => {
    it("extracts euler angles", () => {
      const q = Quaternion.fromEulerAngles(0.1, 0.2, 0.3);
      const euler = q.toEulerAngles();
      expect(euler.x).toBeCloseTo(0.1, 4);
      expect(euler.y).toBeCloseTo(0.2, 4);
      expect(euler.z).toBeCloseTo(0.3, 4);
    });
  });

  describe("slerp", () => {
    it("returns start at t=0", () => {
      const q1 = Quaternion.fromAxisAngle(Vector3d.unitZ(), 0);
      const q2 = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI);
      const result = q1.slerp(q2, 0);
      expect(result.equals(q1, 1e-10)).toBe(true);
    });

    it("returns end at t=1", () => {
      const q1 = Quaternion.fromAxisAngle(Vector3d.unitZ(), 0);
      const q2 = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const result = q1.slerp(q2, 1);
      expect(result.x).toBeCloseTo(q2.x);
      expect(result.y).toBeCloseTo(q2.y);
      expect(result.z).toBeCloseTo(q2.z);
      expect(result.w).toBeCloseTo(q2.w);
    });

    it("interpolates at t=0.5", () => {
      const q1 = Quaternion.fromAxisAngle(Vector3d.unitZ(), 0);
      const q2 = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const result = q1.slerp(q2, 0.5);

      // Should be 45 degree rotation
      const v = new Vector3d(1, 0, 0);
      const rotated = result.rotateVector(v);
      expect(rotated.x).toBeCloseTo(Math.cos(Math.PI / 4));
      expect(rotated.y).toBeCloseTo(Math.sin(Math.PI / 4));
    });
  });

  describe("equals", () => {
    it("returns true for identical quaternions", () => {
      const q1 = new Quaternion(1, 2, 3, 4);
      const q2 = new Quaternion(1, 2, 3, 4);
      expect(q1.equals(q2)).toBe(true);
    });

    it("returns false for different quaternions", () => {
      const q1 = new Quaternion(1, 2, 3, 4);
      const q2 = new Quaternion(1, 2, 3, 5);
      expect(q1.equals(q2)).toBe(false);
    });

    it("supports tolerance", () => {
      const q1 = new Quaternion(1, 2, 3, 4);
      const q2 = new Quaternion(1.001, 2.001, 3.001, 4.001);
      expect(q1.equals(q2, 0.01)).toBe(true);
    });
  });

  describe("toMatrix", () => {
    it("returns identity matrix for identity quaternion", () => {
      const q = Quaternion.identity();
      const m = q.toMatrix();
      expect(m[0]).toBeCloseTo(1);
      expect(m[5]).toBeCloseTo(1);
      expect(m[10]).toBeCloseTo(1);
      expect(m[15]).toBeCloseTo(1);
    });

    it("rotation matrix rotates correctly", () => {
      const q = Quaternion.fromAxisAngle(Vector3d.unitZ(), Math.PI / 2);
      const m = q.toMatrix();

      // Apply matrix to vector (1,0,0)
      const x = m[0] * 1 + m[4] * 0 + m[8] * 0;
      const y = m[1] * 1 + m[5] * 0 + m[9] * 0;
      const z = m[2] * 1 + m[6] * 0 + m[10] * 0;

      expect(x).toBeCloseTo(0);
      expect(y).toBeCloseTo(1);
      expect(z).toBeCloseTo(0);
    });
  });

  describe("fromRotationMatrix", () => {
    it("reconstructs quaternion from its matrix", () => {
      const original = Quaternion.fromAxisAngle(new Vector3d(1, 1, 1).normalize(), Math.PI / 3);
      const matrix = original.toMatrix();
      const reconstructed = Quaternion.fromRotationMatrix(matrix);

      // Quaternions q and -q represent the same rotation
      const sameRotation =
        original.equals(reconstructed, 1e-10) ||
        original.equals(new Quaternion(-reconstructed.x, -reconstructed.y, -reconstructed.z, -reconstructed.w), 1e-10);

      expect(sameRotation).toBe(true);
    });
  });

  describe("dot", () => {
    it("computes dot product", () => {
      const q1 = new Quaternion(1, 0, 0, 0);
      const q2 = new Quaternion(1, 0, 0, 0);
      expect(q1.dot(q2)).toBe(1);
    });

    it("returns 0 for perpendicular quaternions", () => {
      const q1 = new Quaternion(1, 0, 0, 0);
      const q2 = new Quaternion(0, 1, 0, 0);
      expect(q1.dot(q2)).toBe(0);
    });
  });

  describe("clone", () => {
    it("creates independent copy", () => {
      const q = new Quaternion(1, 2, 3, 4);
      const clone = q.clone();
      expect(clone.equals(q)).toBe(true);
      expect(clone).not.toBe(q);
    });
  });
});
