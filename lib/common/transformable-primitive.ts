import { SceneObject } from "./scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import type { AxisLike } from "../math/axis.js";
import type { PlaneLike } from "../math/plane.js";
import type { PointLike } from "../math/point.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { rad } from "../helpers/math-helpers.js";

export abstract class TransformablePrimitive extends SceneObject {

  transform(matrix: Matrix4): this {
    this.composeAppliedTransform(matrix);
    return this;
  }

  translate(x: number): this;
  translate(x: number, y: number): this;
  translate(x: number, y: number, z: number): this;
  translate(p: PointLike): this;
  translate(a: number | PointLike, b?: number, c?: number): this {
    let x: number, y: number, z: number;
    if (typeof a === 'number') {
      x = a;
      y = b ?? 0;
      z = c ?? 0;
    } else if (Array.isArray(a)) {
      x = a[0] ?? 0; y = a[1] ?? 0; z = a[2] ?? 0;
    } else {
      x = a.x; y = a.y; z = a.z;
    }
    return this.transform(Matrix4.fromTranslation(x, y, z));
  }

  rotate(angle: number): this;
  rotate(axis: AxisLike, angle: number): this;
  rotate(a: number | AxisLike, b?: number): this {
    let origin: Point;
    let direction: Vector3d;
    let angleDeg: number;

    if (typeof a === 'number') {
      origin = new Point(0, 0, 0);
      direction = Vector3d.unitZ();
      angleDeg = a;
    } else {
      const resolved = resolveAxisLike(a);
      origin = resolved.origin;
      direction = resolved.direction;
      angleDeg = b as number;
    }

    return this.transform(Matrix4.fromRotationAroundAxis(origin, direction, rad(angleDeg)));
  }

  mirror(plane: PlaneLike): this;
  mirror(axis: AxisLike): this;
  mirror(arg: PlaneLike | AxisLike): this {
    if (isAxisLikeArg(arg)) {
      const axis = resolveAxisLike(arg as AxisLike);
      return this.transform(Matrix4.mirrorAxis(axis.origin, axis.direction));
    }
    const plane = resolvePlaneLike(arg as PlaneLike);
    return this.transform(Matrix4.mirrorPlane(plane.normal, plane.origin));
  }
}

function isAxisLikeArg(arg: any): boolean {
  if (arg === 'x' || arg === 'y' || arg === 'z') {
    return true;
  }
  if (arg && typeof arg === 'object') {
    if (typeof arg.getAxis === 'function') {
      return true;
    }
    if (arg.origin && arg.direction) {
      return true;
    }
  }
  return false;
}

function resolveAxisLike(arg: AxisLike): { origin: Point; direction: Vector3d } {
  if (arg === 'x') {
    return { origin: new Point(0, 0, 0), direction: Vector3d.unitX() };
  }
  if (arg === 'y') {
    return { origin: new Point(0, 0, 0), direction: Vector3d.unitY() };
  }
  if (arg === 'z') {
    return { origin: new Point(0, 0, 0), direction: Vector3d.unitZ() };
  }
  const a = arg as any;
  if (typeof a.getAxis === 'function') {
    const axis = a.getAxis();
    return { origin: axis.origin, direction: axis.direction };
  }
  return { origin: a.origin, direction: a.direction };
}

function resolvePlaneLike(arg: PlaneLike): { origin: Point; normal: Vector3d } {
  if (typeof arg === 'string') {
    switch (arg) {
      case 'xy':
      case 'top':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitZ() };
      case '-xy':
      case 'bottom':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitZ().multiply(-1) };
      case 'xz':
      case 'front':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitY().multiply(-1) };
      case '-xz':
      case 'back':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitY() };
      case 'yz':
      case 'right':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitX() };
      case '-yz':
      case 'left':
        return { origin: new Point(0, 0, 0), normal: Vector3d.unitX().multiply(-1) };
    }
  }
  const p = arg as any;
  if (typeof p.getPlane === 'function') {
    const plane = p.getPlane();
    return { origin: plane.origin, normal: plane.normal };
  }
  return { origin: p.origin, normal: p.normal };
}
