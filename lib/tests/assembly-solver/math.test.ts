import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Matrix3, Quaternion, Vector3 } from "../../assembly-solver/math.js";

// The solver's vector math mirrors the three.js classes the solver was
// written against — same methods, same argument order, same arithmetic —
// so the move off three.js changed no number a solve produces. Each case
// runs one operation on both and expects the results bit for bit.

/** A small deterministic generator, so a failure names the same inputs every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 * 20 - 10;
  };
}

const SAMPLES = 200;

function vectors(next: () => number): { ours: Vector3; theirs: THREE.Vector3 } {
  const [x, y, z] = [next(), next(), next()];
  return { ours: new Vector3(x, y, z), theirs: new THREE.Vector3(x, y, z) };
}

function unitQuaternions(next: () => number): { ours: Quaternion; theirs: THREE.Quaternion } {
  const theirs = new THREE.Quaternion(next(), next(), next(), next()).normalize();
  return { ours: new Quaternion(theirs.x, theirs.y, theirs.z, theirs.w), theirs };
}

function sameVector(ours: Vector3, theirs: THREE.Vector3): void {
  expect([ours.x, ours.y, ours.z]).toEqual([theirs.x, theirs.y, theirs.z]);
}

function sameQuaternion(ours: Quaternion, theirs: THREE.Quaternion): void {
  expect([ours.x, ours.y, ours.z, ours.w]).toEqual([theirs.x, theirs.y, theirs.z, theirs.w]);
}

describe("assembly-solver math matches three.js", () => {
  it("Vector3 arithmetic", () => {
    const next = lcg(1);
    for (let i = 0; i < SAMPLES; i++) {
      const a = vectors(next);
      const b = vectors(next);
      const s = next();
      sameVector(a.ours.clone().add(b.ours), a.theirs.clone().add(b.theirs));
      sameVector(a.ours.clone().sub(b.ours), a.theirs.clone().sub(b.theirs));
      sameVector(a.ours.clone().addScaledVector(b.ours, s), a.theirs.clone().addScaledVector(b.theirs, s));
      sameVector(a.ours.clone().multiplyScalar(s), a.theirs.clone().multiplyScalar(s));
      sameVector(a.ours.clone().negate(), a.theirs.clone().negate());
      sameVector(a.ours.clone().normalize(), a.theirs.clone().normalize());
      sameVector(a.ours.clone().cross(b.ours), a.theirs.clone().cross(b.theirs));
      sameVector(new Vector3().crossVectors(a.ours, b.ours), new THREE.Vector3().crossVectors(a.theirs, b.theirs));
      sameVector(new Vector3().copy(a.ours).set(s, b.ours.y, 0), new THREE.Vector3().copy(a.theirs).set(s, b.theirs.y, 0));
      expect(a.ours.dot(b.ours)).toBe(a.theirs.dot(b.theirs));
      expect(a.ours.length()).toBe(a.theirs.length());
      expect(a.ours.lengthSq()).toBe(a.theirs.lengthSq());
      expect(a.ours.distanceTo(b.ours)).toBe(a.theirs.distanceTo(b.theirs));
    }
  });

  it("normalizing the zero vector leaves it zero", () => {
    sameVector(new Vector3().normalize(), new THREE.Vector3().normalize());
  });

  it("Vector3 rotations", () => {
    const next = lcg(2);
    for (let i = 0; i < SAMPLES; i++) {
      const v = vectors(next);
      const q = unitQuaternions(next);
      const axis = vectors(next);
      axis.ours.normalize();
      axis.theirs.normalize();
      const angle = next();
      sameVector(v.ours.clone().applyQuaternion(q.ours), v.theirs.clone().applyQuaternion(q.theirs));
      sameVector(v.ours.clone().applyAxisAngle(axis.ours, angle), v.theirs.clone().applyAxisAngle(axis.theirs, angle));
    }
  });

  it("Quaternion operations", () => {
    const next = lcg(3);
    for (let i = 0; i < SAMPLES; i++) {
      const a = unitQuaternions(next);
      const b = unitQuaternions(next);
      const axis = vectors(next);
      axis.ours.normalize();
      axis.theirs.normalize();
      const angle = next();
      sameQuaternion(a.ours.clone().multiply(b.ours), a.theirs.clone().multiply(b.theirs));
      sameQuaternion(a.ours.clone().invert(), a.theirs.clone().invert());
      sameQuaternion(new Quaternion().copy(a.ours), new THREE.Quaternion().copy(a.theirs));
      sameQuaternion(new Quaternion().setFromAxisAngle(axis.ours, angle), new THREE.Quaternion().setFromAxisAngle(axis.theirs, angle));
      const [x, y, z, w] = [next(), next(), next(), next()];
      sameQuaternion(new Quaternion(x, y, z, w).normalize(), new THREE.Quaternion(x, y, z, w).normalize());
      expect(a.ours.dot(b.ours)).toBe(a.theirs.dot(b.theirs));
      expect(new Quaternion(x, y, z, w).length()).toBe(new THREE.Quaternion(x, y, z, w).length());
    }
  });

  it("the default quaternion is the identity, and normalizing zero gives it", () => {
    sameQuaternion(new Quaternion(), new THREE.Quaternion());
    sameQuaternion(new Quaternion(0, 0, 0, 0).normalize(), new THREE.Quaternion(0, 0, 0, 0).normalize());
  });

  it("a rotation built from two bases, as a fastened mate builds its target", () => {
    const next = lcg(4);
    for (let i = 0; i < SAMPLES; i++) {
      // Two orthonormal bases from random rotations — every branch of the
      // matrix-to-quaternion conversion comes up over the samples.
      const p = unitQuaternions(next);
      const q = unitQuaternions(next);
      const basis = (rotation: THREE.Quaternion) => [
        new THREE.Vector3(1, 0, 0).applyQuaternion(rotation),
        new THREE.Vector3(0, 1, 0).applyQuaternion(rotation),
        new THREE.Vector3(0, 0, 1).applyQuaternion(rotation),
      ] as const;
      const [px, py, pz] = basis(p.theirs);
      const [qx, qy, qz] = basis(q.theirs);

      const theirTarget = new THREE.Matrix4().makeBasis(px, py, pz);
      const theirLocal = new THREE.Matrix4().makeBasis(qx, qy, qz);
      const theirs = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().multiplyMatrices(theirTarget, theirLocal.clone().transpose()),
      );

      const ourTarget = new Matrix3().makeBasis(px, py, pz);
      const ourLocal = new Matrix3().makeBasis(qx, qy, qz);
      const ours = new Quaternion().setFromRotationMatrix(
        new Matrix3().multiplyMatrices(ourTarget, ourLocal.clone().transpose()),
      );

      sameQuaternion(ours, theirs);
    }
  });
});
