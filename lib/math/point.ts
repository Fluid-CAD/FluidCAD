import { Vector3d } from "./vector3d.js";
import { Matrix4 } from "./matrix4.js";
import type { Axis } from "./axis.js";
import { Plane } from "./plane.js";
import { LazyVertex } from "../features/lazy-vertex.js";

export class Point {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number
  ) {}

  equals(other: Point, tolerance: number = 0): boolean {
    if (tolerance === 0) {
      return this.x === other.x && this.y === other.y && this.z === other.z;
    }
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.z - other.z) <= tolerance
    );
  }

  distanceTo(other: Point | Vector3d): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  distanceToSquared(other: Point | Vector3d): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return dx * dx + dy * dy + dz * dz;
  }

  add(other: Vector3d | Point): Point {
    return new Point(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  subtract(other: Vector3d | Point): Point {
    return new Point(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  multiplyScalar(scalar: number): Point {
    return new Point(this.x * scalar, this.y * scalar, this.z * scalar);
  }

  multiply(other: Vector3d | Point): Point {
    return new Point(this.x * other.x, this.y * other.y, this.z * other.z);
  }

  translate(dx: number, dy: number, dz: number = 0): Point {
    return new Point(this.x + dx, this.y + dy, this.z + dz);
  }

  translateX(dx: number): Point {
    return new Point(this.x + dx, this.y, this.z);
  }

  translateY(dy: number): Point {
    return new Point(this.x, this.y + dy, this.z);
  }

  translateZ(dz: number): Point {
    return new Point(this.x, this.y, this.z + dz);
  }

  vectorTo(other: Point): Vector3d {
    return new Vector3d(other.x - this.x, other.y - this.y, other.z - this.z);
  }

  lerp(other: Point, t: number): Point {
    return new Point(
      this.x + (other.x - this.x) * t,
      this.y + (other.y - this.y) * t,
      this.z + (other.z - this.z) * t
    );
  }

  transform(matrix: Matrix4): Point {
    return matrix.transformPoint(this);
  }

  mirrorAroundAxis(axis: Axis): Point {
    return this.transform(Matrix4.mirrorAxis(axis.origin, axis.direction));
  }

  mirrorAroundPoint(point: Point): Point {
    return this.transform(Matrix4.mirrorPoint(point));
  }

  toVector3d(): Vector3d {
    return new Vector3d(this.x, this.y, this.z);
  }

  toPoint2D(): Point2D {
    return new Point2D(this.x, this.y);
  }

  clone(): Point {
    return new Point(this.x, this.y, this.z);
  }

  negate(): Point {
    return new Point(-this.x, -this.y, -this.z);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `Point(${this.x}, ${this.y}, ${this.z})`;
  }

  static fromVector3d(v: Vector3d): Point {
    return new Point(v.x, v.y, v.z);
  }

  static fromArray(arr: [number, number, number]): Point {
    return new Point(arr[0], arr[1], arr[2]);
  }

  static origin(): Point {
    return new Point(0, 0, 0);
  }
}

export class Point2D {
  constructor(
    public readonly x: number,
    public readonly y: number
  ) {}

  equals(other: Point2D, tolerance: number = 0): boolean {
    if (!other) {
      return false;
    }

    if (tolerance === 0) {
      return this.x === other.x && this.y === other.y;
    }
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance
    );
  }

  distanceTo(other: Point2D): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  distanceToSquared(other: Point2D): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return dx * dx + dy * dy;
  }

  add(other: Point2D): Point2D {
    return new Point2D(this.x + other.x, this.y + other.y);
  }

  subtract(other: Point2D): Point2D {
    return new Point2D(this.x - other.x, this.y - other.y);
  }

  multiply(other: Point2D): Point2D {
    return new Point2D(this.x * other.x, this.y * other.y);
  }

  multiplyScalar(scalar: number): Point2D {
    return new Point2D(this.x * scalar, this.y * scalar);
  }

  translate(dx: number, dy: number): Point2D {
    return new Point2D(this.x + dx, this.y + dy);
  }

  normalize(): Point2D {
    const len = Math.sqrt(this.x * this.x + this.y * this.y);
    if (len === 0) {
      return new Point2D(0, 0);
    }
    return new Point2D(this.x / len, this.y / len);
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  lerp(other: Point2D, t: number): Point2D {
    return new Point2D(
      this.x + (other.x - this.x) * t,
      this.y + (other.y - this.y) * t
    );
  }

  rotate(angle: number, pivot: Point2D = new Point2D(0, 0)): Point2D {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = this.x - pivot.x;
    const dy = this.y - pivot.y;
    return new Point2D(
      pivot.x + dx * cos - dy * sin,
      pivot.y + dx * sin + dy * cos
    );
  }

  mirrorAroundAxis(axis: Axis): Point2D {
    const origin = new Point2D(axis.origin.x, axis.origin.y);
    const dir = new Point2D(axis.direction.x, axis.direction.y).normalize();
    const v = this.subtract(origin);
    const projLength = v.x * dir.x + v.y * dir.y;
    const closest = origin.add(dir.multiplyScalar(projLength));
    return closest.multiplyScalar(2).subtract(this);
  }

  mirrorAroundPoint(pivot: Point2D): Point2D {
    return pivot.multiplyScalar(2).subtract(this);
  }

  transform(matrix: Matrix4): Point2D {
    const p = matrix.transformPoint(this.toPoint());
    return new Point2D(p.x, p.y);
  }

  toPoint(z: number = 0): Point {
    return new Point(this.x, this.y, z);
  }

  clone(): Point2D {
    return new Point2D(this.x, this.y);
  }

  negate(): Point2D {
    return new Point2D(-this.x, -this.y);
  }

  toArray(): [number, number] {
    return [this.x, this.y];
  }

  toString(): string {
    return `Point2D(${this.x}, ${this.y})`;
  }

  static fromArray(arr: [number, number]): Point2D {
    return new Point2D(arr[0], arr[1]);
  }

  static origin(): Point2D {
    return new Point2D(0, 0);
  }
}

export type PointLike =
  | Point
  | [number, number, number]
  | { x: number; y: number; z: number };

export type Point2DLike =
  | Point2D
  | [number, number]
  | { x: number; y: number }
  | LazyVertex;

export function isPoint2DLike(value: unknown): value is Point2DLike {
  if (value instanceof Point2D || value instanceof LazyVertex) {
    return true;
  }

  if (Array.isArray(value) && value.length === 2) return true;
  if (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    !("z" in value)
  ) {
    return true;
  }
  return false;
}

export function isPointLike(value: unknown): value is PointLike {
  if (value instanceof Point) return true;
  if (Array.isArray(value) && value.length === 3) return true;
  if (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    "z" in value
  ) {
    return true;
  }
  return false;
}
