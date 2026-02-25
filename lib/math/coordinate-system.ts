import { Point } from "./point.js";
import { Vector3d } from "./vector3d.js";
import { Axis } from "./axis.js";
import { Plane, PlaneLike, toPlane } from "./plane.js";
import { Matrix4 } from "./matrix4.js";

export class CoordinateSystem {
  public readonly yDirection: Vector3d;

  constructor(
    public readonly origin: Point,
    public readonly mainDirection: Vector3d,
    public readonly xDirection: Vector3d
  ) {
    this.yDirection = this.mainDirection.cross(this.xDirection).normalize();
  }

  get xAxis(): Axis {
    return new Axis(this.origin, this.xDirection);
  }

  get yAxis(): Axis {
    return new Axis(this.origin, this.yDirection);
  }

  get mainAxis(): Axis {
    return new Axis(this.origin, this.mainDirection);
  }

  get zAxis(): Axis {
    return this.mainAxis;
  }

  angle(other: CoordinateSystem): number {
    return this.mainDirection.angleTo(other.mainDirection);
  }

  isCoplanar(other: CoordinateSystem, linearTolerance: number = 1e-10, angularTolerance: number = 1e-10): boolean {
    if (!this.mainDirection.isParallelTo(other.mainDirection, angularTolerance)) {
      return false;
    }

    const v = this.origin.vectorTo(other.origin);
    const distance = Math.abs(v.dot(this.mainDirection));

    return distance <= linearTolerance;
  }

  applyMatrix(matrix: Matrix4): CoordinateSystem {
    return new CoordinateSystem(
      matrix.transformPoint(this.origin),
      matrix.transformDirection(this.mainDirection),
      matrix.transformDirection(this.xDirection)
    );
  }

  mirrorAroundPoint(point: Point): CoordinateSystem {
    const matrix = Matrix4.mirrorPoint(point);
    return this.applyMatrix(matrix);
  }

  mirrorAroundAxis(axis: Axis): CoordinateSystem {
    const matrix = Matrix4.mirrorAxis(axis.origin, axis.direction);
    return this.applyMatrix(matrix);
  }

  mirrorAroundPlane(planeNormal: Vector3d, pointOnPlane: Point): CoordinateSystem {
    const matrix = Matrix4.mirrorPlane(planeNormal, pointOnPlane);
    return this.applyMatrix(matrix);
  }

  rotate(axis: Axis, angle: number): CoordinateSystem {
    const toOrigin = Matrix4.fromTranslation(-axis.origin.x, -axis.origin.y, -axis.origin.z);
    const rotate = Matrix4.fromAxisAngle(axis.direction, angle);
    const fromOrigin = Matrix4.fromTranslation(axis.origin.x, axis.origin.y, axis.origin.z);
    const matrix = fromOrigin.multiply(rotate).multiply(toOrigin);

    return this.applyMatrix(matrix);
  }

  scale(point: Point, factor: number): CoordinateSystem {
    const toOrigin = Matrix4.fromTranslation(-point.x, -point.y, -point.z);
    const scaleMatrix = Matrix4.fromUniformScale(factor);
    const fromOrigin = Matrix4.fromTranslation(point.x, point.y, point.z);
    const matrix = fromOrigin.multiply(scaleMatrix).multiply(toOrigin);

    return new CoordinateSystem(
      matrix.transformPoint(this.origin),
      this.mainDirection,
      this.xDirection
    );
  }

  translate(dx: number, dy: number, dz: number): CoordinateSystem {
    return new CoordinateSystem(
      this.origin.translate(dx, dy, dz),
      this.mainDirection,
      this.xDirection
    );
  }

  translateVector(v: Vector3d): CoordinateSystem {
    return this.translate(v.x, v.y, v.z);
  }

  getXYPlane(): Plane {
    return new Plane(this.origin, this.xDirection, this.mainDirection);
  }

  getXZPlane(): Plane {
    return new Plane(this.origin, this.xDirection, this.yDirection.negate());
  }

  getYZPlane(): Plane {
    return new Plane(this.origin, this.yDirection, this.xDirection);
  }

  worldToLocal(point: Point): Point {
    const v = this.origin.vectorTo(point);
    return new Point(
      v.dot(this.xDirection),
      v.dot(this.yDirection),
      v.dot(this.mainDirection)
    );
  }

  localToWorld(point: Point): Point {
    return this.origin
      .add(this.xDirection.multiply(point.x))
      .add(this.yDirection.multiply(point.y))
      .add(this.mainDirection.multiply(point.z));
  }

  worldToLocalVector(v: Vector3d): Vector3d {
    return new Vector3d(
      v.dot(this.xDirection),
      v.dot(this.yDirection),
      v.dot(this.mainDirection)
    );
  }

  localToWorldVector(v: Vector3d): Vector3d {
    return this.xDirection
      .multiply(v.x)
      .add(this.yDirection.multiply(v.y))
      .add(this.mainDirection.multiply(v.z));
  }

  getBasisMatrix(): Matrix4 {
    return Matrix4.fromBasis(this.xDirection, this.yDirection, this.mainDirection, this.origin);
  }

  getInverseBasisMatrix(): Matrix4 {
    return this.getBasisMatrix().inverse();
  }

  equals(other: CoordinateSystem, tolerance: number = 0): boolean {
    return (
      this.origin.equals(other.origin, tolerance) &&
      this.mainDirection.equals(other.mainDirection, tolerance) &&
      this.xDirection.equals(other.xDirection, tolerance)
    );
  }

  clone(): CoordinateSystem {
    return new CoordinateSystem(
      this.origin.clone(),
      this.mainDirection.clone(),
      this.xDirection.clone()
    );
  }

  toString(): string {
    return `CoordinateSystem(origin: ${this.origin.toString()}, mainDirection: ${this.mainDirection.toString()}, xDirection: ${this.xDirection.toString()})`;
  }

  private static _world: CoordinateSystem | null = null;

  static World(): CoordinateSystem {
    if (!CoordinateSystem._world) {
      CoordinateSystem._world = new CoordinateSystem(
        Point.origin(),
        Vector3d.unitZ(),
        Vector3d.unitX()
      );
    }
    return CoordinateSystem._world;
  }

  static fromPlane(plane: PlaneLike): CoordinateSystem {
    const p = toPlane(plane);
    return new CoordinateSystem(p.origin, p.normal, p.xDirection);
  }

  static fromOriginAndAxes(origin: Point, xAxis: Vector3d, _yAxis: Vector3d, zAxis: Vector3d): CoordinateSystem {
    return new CoordinateSystem(origin, zAxis, xAxis);
  }

  static fromTwoAxes(origin: Point, primaryAxis: Vector3d, secondaryAxis: Vector3d): CoordinateSystem {
    const z = primaryAxis.normalize();
    const y = z.cross(secondaryAxis.normalize()).normalize();
    const x = y.cross(z).normalize();
    return new CoordinateSystem(origin, z, x);
  }
}
