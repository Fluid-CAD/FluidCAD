import { Matrix4 } from "../math/matrix4.js";
import { Vector3d, Vector3dLike } from "../math/vector3d.js";
import { Axis, AxisLike } from "../math/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { normalizeAxis, normalizeVector } from "../helpers/normalize.js";

/** A world axis name, optionally negated: `'z'` points up, `'-z'` points down. */
export type SignedAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

/**
 * What the rank filters accept as a direction: a signed world axis name, a
 * vector, or an axis (resolved or an `axis()` feature). Plane names are
 * deliberately not accepted — `nearest('xy')` reads as "closest to the xy
 * plane", not "least z", so directions are always spelled as axes.
 */
export type DirectionLike = SignedAxis | Vector3dLike | AxisLike;

const SIGNED_AXES: Record<SignedAxis, [number, number, number]> = {
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
  '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1],
};

export function isSignedAxis(value: unknown): value is SignedAxis {
  return typeof value === 'string' && value in SIGNED_AXES;
}

/**
 * Resolve a direction to a unit vector. Axis features resolve lazily (their
 * axis exists once built), so call this at match time, not at builder time.
 */
export function resolveDirection(direction: DirectionLike): Vector3d {
  if (isSignedAxis(direction)) {
    return Vector3d.fromArray(SIGNED_AXES[direction]);
  }
  if (direction instanceof Axis) {
    return direction.direction.normalize();
  }
  if (direction instanceof AxisObjectBase) {
    return direction.getAxis().direction.normalize();
  }
  if (Array.isArray(direction) || direction instanceof Vector3d
    || (typeof direction === 'object' && direction !== null && 'x' in direction)) {
    const v = normalizeVector(direction as Vector3dLike);
    if (v.isZero(1e-12)) {
      throw new Error('Direction vector must not be zero');
    }
    return v.normalize();
  }
  if (typeof direction === 'string') {
    throw new Error(`Unknown direction '${direction}' — use 'x', 'y', 'z', '-x', '-y', '-z', a vector, or an axis`);
  }
  return normalizeAxis(direction as AxisLike).direction.normalize();
}

/** Structural equality of two direction arguments (scene-compare reuse). */
export function compareDirections(a: DirectionLike, b: DirectionLike): boolean {
  if (a instanceof AxisObjectBase || b instanceof AxisObjectBase) {
    return a instanceof AxisObjectBase && b instanceof AxisObjectBase && a.compareTo(b);
  }
  try {
    return resolveDirection(a).equals(resolveDirection(b), 1e-10);
  } catch {
    return false;
  }
}

/** The direction as seen by a transformed clone (mirrors flip it). */
export function transformDirection(direction: DirectionLike, matrix: Matrix4): Vector3d {
  return matrix.transformDirection(resolveDirection(direction)).normalize();
}
