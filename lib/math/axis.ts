import { Point } from "./point.js";
import { Vector3d } from "./vector3d.js";
import { Matrix4 } from "./matrix4.js";
import { Quaternion } from "./quaternion.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { IAxis } from "../core/interfaces.js";

export interface AxisTransformOptions {
  offsetX?: number;
  offsetY?: number;
  offsetZ?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
}

export class Axis {
  constructor(
    public readonly origin: Point,
    public readonly direction: Vector3d
  ) {}

  equals(other: Axis, tolerance: number = 0): boolean {
    return (
      this.origin.equals(other.origin, tolerance) &&
      this.direction.equals(other.direction, tolerance)
    );
  }

  add(other: Axis): Axis {
    const newOrigin = this.origin.add(other.origin.toVector3d());
    const newDirection = this.direction.add(other.direction).normalize();
    return new Axis(newOrigin, newDirection);
  }

  translate(dx: number, dy: number, dz: number): Axis {
    return new Axis(this.origin.translate(dx, dy, dz), this.direction);
  }

  translateVector(v: Vector3d): Axis {
    return new Axis(this.origin.add(v), this.direction);
  }

  applyMatrix(matrix: Matrix4): Axis {
    return new Axis(
      matrix.transformPoint(this.origin),
      matrix.transformDirection(this.direction)
    );
  }

  rotateAroundAxis(axis: Axis, angle: number): Axis {
    const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, angle);
    return this.applyMatrix(matrix);
  }

  rotateX(angle: number): Axis {
    const matrix = Matrix4.fromRotationX(angle);
    return this.applyMatrix(matrix);
  }

  rotateY(angle: number): Axis {
    const matrix = Matrix4.fromRotationY(angle);
    return this.applyMatrix(matrix);
  }

  rotateZ(angle: number): Axis {
    const matrix = Matrix4.fromRotationZ(angle);
    return this.applyMatrix(matrix);
  }

  transform(options: AxisTransformOptions): Axis {
    let result: Axis = this;

    // Apply translation first
    if (options.offsetX || options.offsetY || options.offsetZ) {
      result = result.translate(
        options.offsetX || 0,
        options.offsetY || 0,
        options.offsetZ || 0
      );
    }

    const hasRotation = options.rotateX || options.rotateY || options.rotateZ;
    if (!hasRotation) {
      return result;
    }

    // Compose all rotations into a single quaternion to avoid gimbal lock
    let q = Quaternion.identity();
    if (options.rotateX) {
      q = q.multiply(Quaternion.fromAxisAngle(Vector3d.unitX(), options.rotateX));
    }
    if (options.rotateY) {
      q = q.multiply(Quaternion.fromAxisAngle(Vector3d.unitY(), options.rotateY));
    }
    if (options.rotateZ) {
      q = q.multiply(Quaternion.fromAxisAngle(Vector3d.unitZ(), options.rotateZ));
    }

    // Apply the composed rotation around the axis origin
    const toOrigin = Matrix4.fromTranslation(-result.origin.x, -result.origin.y, -result.origin.z);
    const rotation = Matrix4.fromQuaternion(q);
    const fromOrigin = Matrix4.fromTranslation(result.origin.x, result.origin.y, result.origin.z);
    const matrix = fromOrigin.multiply(rotation).multiply(toOrigin);

    return result.applyMatrix(matrix);
  }

  isParallelTo(other: Axis, tolerance: number = 1e-10): boolean {
    return this.direction.isParallelTo(other.direction, tolerance);
  }

  isPerpendicularTo(other: Axis, tolerance: number = 1e-10): boolean {
    return this.direction.isPerpendicularTo(other.direction, tolerance);
  }

  isPerpendicularToVector(vector: Vector3d, tolerance: number = 1e-6): boolean {
    return Math.abs(this.direction.dot(vector)) <= tolerance;
  }

  distanceToPoint(point: Point): number {
    const v = this.origin.vectorTo(point);
    const projected = v.projectOnto(this.direction);
    const perpendicular = v.subtract(projected);
    return perpendicular.length();
  }

  closestPointOnAxis(point: Point): Point {
    const v = this.origin.vectorTo(point);
    const t = v.dot(this.direction);
    return this.origin.add(this.direction.multiply(t));
  }

  pointAtParameter(t: number): Point {
    return this.origin.add(this.direction.multiply(t));
  }

  reverse(): Axis {
    return new Axis(this.origin, this.direction.negate());
  }

  mirrorAroundPoint(point: Point): Axis {
    const matrix = Matrix4.mirrorPoint(point);
    return this.applyMatrix(matrix);
  }

  mirrorAroundPlane(planeNormal: Vector3d, pointOnPlane: Point): Axis {
    const matrix = Matrix4.mirrorPlane(planeNormal, pointOnPlane);
    return this.applyMatrix(matrix);
  }

  mirrorAroundAxis(mirrorAxis: Axis): Axis {
    const matrix = Matrix4.mirrorAxis(mirrorAxis.origin, mirrorAxis.direction);
    return this.applyMatrix(matrix);
  }

  clone(): Axis {
    return new Axis(this.origin.clone(), this.direction.clone());
  }

  serialize(): { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } {
    return {
      origin: { x: this.origin.x, y: this.origin.y, z: this.origin.z },
      direction: { x: this.direction.x, y: this.direction.y, z: this.direction.z },
    };
  }

  toString(): string {
    return `Axis(origin: ${this.origin.toString()}, direction: ${this.direction.toString()})`;
  }

  static X(): Axis {
    return new Axis(Point.origin(), Vector3d.unitX());
  }

  static Y(): Axis {
    return new Axis(Point.origin(), Vector3d.unitY());
  }

  static Z(): Axis {
    return new Axis(Point.origin(), Vector3d.unitZ());
  }

  static fromPoints(start: Point, end: Point): Axis {
    const direction = start.vectorTo(end).normalize();
    return new Axis(start, direction);
  }

  static deserialize(data: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }): Axis {
    return new Axis(
      new Point(data.origin.x, data.origin.y, data.origin.z),
      new Vector3d(data.direction.x, data.direction.y, data.direction.z)
    );
  }
}

export type StandardAxis = "x" | "y" | "z";
export type AxisLike = StandardAxis | Axis | IAxis | AxisObjectBase;

export function isAxisLike(value: unknown): value is AxisLike {
  return value instanceof AxisObjectBase || value instanceof Axis || value === "x" || value === "y" || value === "z";
}

export function toAxis(value: AxisLike): Axis {
  if (value instanceof Axis) {
    return value;
  }
  switch (value) {
    case "x":
      return Axis.X();
    case "y":
      return Axis.Y();
    case "z":
      return Axis.Z();
  }
}
