import { Matrix4 } from "./matrix4.js";

export class Vector3d {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number
  ) {}

  equals(other: Vector3d, tolerance: number = 0): boolean {
    if (tolerance === 0) {
      return this.x === other.x && this.y === other.y && this.z === other.z;
    }
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.z - other.z) <= tolerance
    );
  }

  dot(other: Vector3d): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  cross(other: Vector3d): Vector3d {
    return new Vector3d(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x
    );
  }

  isZero(tolerance: number = 0): boolean {
    if (tolerance === 0) {
      return this.x === 0 && this.y === 0 && this.z === 0;
    }
    return this.length() <= tolerance;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  normalize(): Vector3d {
    const len = this.length();
    if (len === 0) {
      throw new Error("Cannot normalize a zero vector");
    }
    return new Vector3d(this.x / len, this.y / len, this.z / len);
  }

  add(other: Vector3d): Vector3d {
    return new Vector3d(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  subtract(other: Vector3d): Vector3d {
    return new Vector3d(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  multiply(scalar: number): Vector3d {
    return new Vector3d(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  divide(scalar: number): Vector3d {
    if (scalar === 0) {
      throw new Error("Cannot divide by zero");
    }
    return new Vector3d(this.x / scalar, this.y / scalar, this.z / scalar);
  }

  negate(): Vector3d {
    return new Vector3d(-this.x, -this.y, -this.z);
  }

  reverse(): Vector3d {
    return new Vector3d(-this.x, -this.y, -this.z);
  }

  distanceTo(other: Vector3d): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  distanceToSquared(other: Vector3d): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return dx * dx + dy * dy + dz * dz;
  }

  angleTo(other: Vector3d): number {
    const denominator = Math.sqrt(this.lengthSquared() * other.lengthSquared());
    if (denominator === 0) {
      return Math.PI / 2;
    }
    const theta = this.dot(other) / denominator;
    return Math.acos(Math.max(-1, Math.min(1, theta)));
  }

  projectOnto(other: Vector3d): Vector3d {
    const denominator = other.lengthSquared();
    if (denominator === 0) {
      return new Vector3d(0, 0, 0);
    }
    const scalar = this.dot(other) / denominator;
    return other.multiply(scalar);
  }

  reflect(normal: Vector3d): Vector3d {
    const n = normal.normalize();
    const dot2 = 2 * this.dot(n);
    return this.subtract(n.multiply(dot2));
  }

  lerp(other: Vector3d, t: number): Vector3d {
    return new Vector3d(
      this.x + (other.x - this.x) * t,
      this.y + (other.y - this.y) * t,
      this.z + (other.z - this.z) * t
    );
  }

  transform(matrix: Matrix4): Vector3d {
    return matrix.transformVector(this);
  }

  clone(): Vector3d {
    return new Vector3d(this.x, this.y, this.z);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `Vector3d(${this.x}, ${this.y}, ${this.z})`;
  }

  isParallelTo(other: Vector3d, tolerance: number = 1e-10): boolean {
    const cross = this.cross(other);
    return cross.lengthSquared() <= tolerance * tolerance;
  }

  isPerpendicularTo(other: Vector3d, tolerance: number = 1e-10): boolean {
    return Math.abs(this.dot(other)) <= tolerance;
  }

  static fromArray(arr: [number, number, number]): Vector3d {
    return new Vector3d(arr[0], arr[1], arr[2]);
  }

  static zero(): Vector3d {
    return new Vector3d(0, 0, 0);
  }

  static unitX(): Vector3d {
    return new Vector3d(1, 0, 0);
  }

  static unitY(): Vector3d {
    return new Vector3d(0, 1, 0);
  }

  static unitZ(): Vector3d {
    return new Vector3d(0, 0, 1);
  }
}

export type Vector3dLike =
  | Vector3d
  | [number, number, number]
  | { x: number; y: number; z: number };

export function normalizeVector(v: Vector3dLike): Vector3d {
  if (v instanceof Vector3d) {
    return v;
  }
  if (Array.isArray(v)) {
    return new Vector3d(v[0], v[1], v[2]);
  }
  return new Vector3d(v.x, v.y, v.z);
}
