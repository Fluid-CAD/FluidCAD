import { Point, Point2D } from "./point.js";
import { Vector3d } from "./vector3d.js";
import { Axis, AxisLike } from "./axis.js";
import { Matrix4 } from "./matrix4.js";
import { Quaternion } from "./quaternion.js";
import { rad } from "../helpers/math-helpers.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { IPlane } from "../core/interfaces.js";

export interface PlaneTransformOptions {
  offset?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
}

export class Plane {
  public readonly yDirection: Vector3d;
  public readonly xAxis: Axis;
  public readonly yAxis: Axis;
  public readonly zAxis: Axis;

  constructor(
    public readonly origin: Point,
    public readonly xDirection: Vector3d,
    public readonly normal: Vector3d,
    yDirection?: Vector3d
  ) {
    this.yDirection = yDirection ?? this.xDirection.cross(this.normal).normalize().multiply(-1);
    this.xAxis = new Axis(this.origin, this.xDirection);
    this.yAxis = new Axis(this.origin, this.yDirection);
    this.zAxis = new Axis(this.origin, this.normal);
  }

  worldToLocal(point: Point): Point2D {
    const v = this.origin.vectorTo(point);
    return new Point2D(v.dot(this.xDirection), v.dot(this.yDirection));
  }

  localToWorld(point: Point2D): Point {
    return this.origin
      .add(this.xDirection.multiply(point.x))
      .add(this.yDirection.multiply(point.y));
  }

  offset(distance: number): Plane {
    const newOrigin = this.origin.add(this.normal.multiply(distance));
    return new Plane(newOrigin, this.xDirection, this.normal);
  }

  transform(options: PlaneTransformOptions): Plane {
    return this.applyMatrix(this.getTransformMatrix(options));
  }

  getTransformMatrix(options: PlaneTransformOptions): Matrix4 {
    const offset = options.offset || 0;
    const offsetVec = this.normal.multiply(offset);
    const offsetMatrix = offset
      ? Matrix4.fromTranslation(offsetVec.x, offsetVec.y, offsetVec.z)
      : Matrix4.identity();

    const hasRotation = options.rotateX || options.rotateY || options.rotateZ;
    if (!hasRotation) {
      return offsetMatrix;
    }

    // Compose all rotations into a single quaternion to avoid gimbal lock.
    // Axes are taken from the current plane (offset doesn't change orientation).
    let q = Quaternion.identity();
    if (options.rotateX) {
      q = q.multiply(Quaternion.fromAxisAngle(this.xDirection, rad(options.rotateX)));
    }
    if (options.rotateY) {
      q = q.multiply(Quaternion.fromAxisAngle(this.yDirection, rad(options.rotateY)));
    }
    if (options.rotateZ) {
      q = q.multiply(Quaternion.fromAxisAngle(this.normal, rad(options.rotateZ)));
    }

    // Rotate around the offset-applied origin (the plane's origin after offset).
    const pivot = this.origin.add(offsetVec);
    const toOrigin = Matrix4.fromTranslation(-pivot.x, -pivot.y, -pivot.z);
    const rotation = Matrix4.fromQuaternion(q);
    const fromOrigin = Matrix4.fromTranslation(pivot.x, pivot.y, pivot.z);
    const rotationMatrix = fromOrigin.multiply(rotation).multiply(toOrigin);

    return rotationMatrix.multiply(offsetMatrix);
  }

  applyMatrix(matrix: Matrix4): Plane {
    return new Plane(
      matrix.transformPoint(this.origin),
      matrix.transformDirection(this.xDirection),
      matrix.transformDirection(this.normal),
      matrix.transformDirection(this.yDirection)
    );
  }

  translateAlongNormal(distance: number): Plane {
    return this.offset(distance);
  }

  translate(dx: number, dy: number, dz: number): Plane {
    return new Plane(
      this.origin.translate(dx, dy, dz),
      this.xDirection,
      this.normal
    );
  }

  translateVector(v: Vector3d): Plane {
    return this.translate(v.x, v.y, v.z);
  }

  rotateAroundAxis(axis: Axis, angle: number): Plane {
    const toOrigin = Matrix4.fromTranslation(-axis.origin.x, -axis.origin.y, -axis.origin.z);
    const rotate = Matrix4.fromAxisAngle(axis.direction, angle);
    const fromOrigin = Matrix4.fromTranslation(axis.origin.x, axis.origin.y, axis.origin.z);
    const matrix = fromOrigin.multiply(rotate).multiply(toOrigin);

    return this.applyMatrix(matrix);
  }

  normalizeAxis(axis: AxisLike): Axis | null {
    if (typeof axis === "string") {
      switch (axis) {
        case "x":
          return this.xAxis;
        case "y":
          return this.yAxis;
        case "z":
          return this.zAxis;
      }
    }
    if (axis instanceof Axis) {
      return axis;
    }
    return null;
  }

  normalizeAxisSafe(axis: AxisLike): Axis | null {
    try {
      return this.normalizeAxis(axis);
    } catch {
      return null;
    }
  }

  projectPoint(point: Point): Point {
    const v = this.origin.vectorTo(point);
    const distance = v.dot(this.normal);
    return point.subtract(this.normal.multiply(distance));
  }

  distanceToPoint(point: Point): number {
    const v = this.origin.vectorTo(point);
    return Math.abs(v.dot(this.normal));
  }

  distanceToPlane(other: Plane): number {
    return Math.abs(this.signedDistanceToPoint(other.origin));
  }

  signedDistanceToPoint(point: Point): number {
    const v = this.origin.vectorTo(point);
    return v.dot(this.normal);
  }

  containsPoint(point: Point, tolerance: number = 1e-10): boolean {
    return Math.abs(this.signedDistanceToPoint(point)) <= tolerance;
  }

  isParallelTo(other: Plane, tolerance: number = 1e-10): boolean {
    return this.normal.isParallelTo(other.normal, tolerance);
  }

  isCoplanarWith(other: Plane, linearTolerance: number = 1e-10, angularTolerance: number = 1e-10): boolean {
    if (!this.isParallelTo(other, angularTolerance)) {
      return false;
    }
    return this.containsPoint(other.origin, linearTolerance);
  }

  reverse(): Plane {
    return new Plane(this.origin, this.xDirection.negate(), this.normal.negate());
  }

  withReversedNormal(): Plane {
    return new Plane(this.origin, this.xDirection.negate(), this.normal.negate());
  }

  mirrorAroundPoint(point: Point): Plane {
    const matrix = Matrix4.mirrorPoint(point);
    return this.applyMatrix(matrix);
  }

  mirrorAroundPlane(planeNormal: Vector3d, pointOnPlane: Point): Plane {
    const matrix = Matrix4.mirrorPlane(planeNormal, pointOnPlane);
    return this.applyMatrix(matrix);
  }

  mirrorAroundAxis(axis: Axis): Plane {
    const matrix = Matrix4.mirrorAxis(axis.origin, axis.direction);
    return this.applyMatrix(matrix);
  }

  compareTo(other: Plane, tolerance: number = 0): boolean {
    return (
      this.origin.equals(other.origin, tolerance) &&
      this.xDirection.equals(other.xDirection, tolerance) &&
      this.normal.equals(other.normal, tolerance)
    );
  }

  clone(): Plane {
    return new Plane(
      this.origin.clone(),
      this.xDirection.clone(),
      this.normal.clone(),
    );
  }

  toString(): string {
    return `Plane(origin: ${this.origin.toString()}, xDirection: ${this.xDirection.toString()}, normal: ${this.normal.toString()})`;
  }

  static XY(): Plane {
    return new Plane(Point.origin(), Vector3d.unitX(), Vector3d.unitZ());
  }

  static XZ(): Plane {
    return new Plane(Point.origin(), Vector3d.unitX(), Vector3d.unitY().negate());
  }

  static YZ(): Plane {
    return new Plane(Point.origin(), Vector3d.unitY(), Vector3d.unitX());
  }

  static fromPointAndNormal(point: Point, normal: Vector3d): Plane {
    const n = normal.normalize();
    let xDir: Vector3d;
    if (Math.abs(n.x) < 0.9) {
      xDir = n.cross(Vector3d.unitX()).normalize();
    } else {
      xDir = n.cross(Vector3d.unitY()).normalize();
    }
    return new Plane(point, xDir, n);
  }

  static fromThreePoints(p1: Point, p2: Point, p3: Point): Plane {
    const v1 = p1.vectorTo(p2);
    const v2 = p1.vectorTo(p3);
    const normal = v1.cross(v2).normalize();
    const xDir = v1.normalize();
    return new Plane(p1, xDir, normal);
  }

  static projectPoint(point: Point, planeOrigin: Point, planeNormal: Vector3d): Point {
    const v = planeOrigin.vectorTo(point);
    const distance = v.dot(planeNormal);
    return point.subtract(planeNormal.multiply(distance));
  }
}

export type StandardPlane =
  | "xy"
  | "xz"
  | "yz"
  | "-xy"
  | "-xz"
  | "-yz"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "left"
  | "right";

export type PlaneLike = StandardPlane | Plane | IPlane | PlaneObjectBase;

export function isPlaneLike(value: unknown): value is PlaneLike {
  return (
    value instanceof Plane ||
    value instanceof PlaneObjectBase ||
    value === "xy" ||
    value === "xz" ||
    value === "yz" ||
    value === "-xy" ||
    value === "-xz" ||
    value === "-yz" ||
    value === "top" ||
    value === "bottom" ||
    value === "front" ||
    value === "back" ||
    value === "left" ||
    value === "right"
  );
}

export function toPlane(value: PlaneLike): Plane {
  if (value instanceof Plane) {
    return value;
  }
  switch (value) {
    case "xy":
    case "top":
      return Plane.XY();
    case "-xy":
    case "bottom":
      return Plane.XY().reverse();
    case "xz":
    case "front":
      return Plane.XZ();
    case "-xz":
    case "back":
      return Plane.XZ().reverse();
    case "yz":
    case "right":
      return Plane.YZ();
    case "-yz":
    case "left":
      return Plane.YZ().reverse();
  }
}
