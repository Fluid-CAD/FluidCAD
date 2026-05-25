import { Matrix4 } from "./matrix4.js";
import { Axis } from "./axis.js";
import { Plane } from "./plane.js";

/** Anything that can be resolved to an `Axis` once built — e.g. `AxisObjectBase`. */
export interface AxisLazySource {
  getAxis(): Axis;
  compareTo?(other: unknown): boolean;
}

/** Anything that can be resolved to a `Plane` once built — e.g. `PlaneObjectBase`. */
export interface PlaneLazySource {
  getPlane(): Plane;
  compareTo?(other: unknown): boolean;
}

function isAxisLazySource(a: Axis | AxisLazySource): a is AxisLazySource {
  return typeof (a as AxisLazySource).getAxis === "function";
}

function isPlaneLazySource(p: Plane | PlaneLazySource): p is PlaneLazySource {
  return typeof (p as PlaneLazySource).getPlane === "function";
}

// Captures HOW a LazyMatrix was constructed so `equals()` can structurally
// compare two instances without resolving them. Resolving requires source
// SceneObjects to have been built, which is not guaranteed at cache-compare
// time (it runs before any render).
type Identity =
  | { kind: "eager"; matrix: Matrix4 }
  | { kind: "rotation"; axis: Axis | AxisLazySource; angle: number }
  | { kind: "translation"; axis: Axis | AxisLazySource; distance: number }
  | { kind: "mirror"; plane: Plane | PlaneLazySource }
  | { kind: "opaque" };

/**
 * Memoized thunk over a Matrix4. Lets parse-time code thread a transform
 * value that depends on scene state (e.g. an AxisObjectBase or
 * PlaneObjectBase) before that state exists. Resolution is deferred to the
 * first call to `resolve()`, by which point the renderer has built the source
 * object. Concrete `Axis` / `Plane` sources resolve eagerly with no extra
 * indirection.
 */
export class LazyMatrix {
  private _resolver: () => Matrix4;
  private _cached: Matrix4 | null;
  private _identity: Identity;

  private constructor(
    resolver: () => Matrix4,
    identity: Identity,
    cached: Matrix4 | null = null,
  ) {
    this._resolver = resolver;
    this._cached = cached;
    this._identity = identity;
  }

  resolve(): Matrix4 {
    if (this._cached === null) {
      this._cached = this._resolver();
    }
    return this._cached;
  }

  equals(other: LazyMatrix, tolerance: number = 0): boolean {
    const a = this._identity;
    const b = other._identity;
    if (a.kind !== b.kind) {
      return false;
    }
    switch (a.kind) {
      case "eager":
        return a.matrix.equals((b as Extract<Identity, { kind: "eager" }>).matrix, tolerance);
      case "rotation": {
        const bo = b as Extract<Identity, { kind: "rotation" }>;
        return Math.abs(a.angle - bo.angle) <= tolerance
          && LazyMatrix.axisSourceEquals(a.axis, bo.axis, tolerance);
      }
      case "translation": {
        const bo = b as Extract<Identity, { kind: "translation" }>;
        return Math.abs(a.distance - bo.distance) <= tolerance
          && LazyMatrix.axisSourceEquals(a.axis, bo.axis, tolerance);
      }
      case "mirror": {
        const bo = b as Extract<Identity, { kind: "mirror" }>;
        return LazyMatrix.planeSourceEquals(a.plane, bo.plane, tolerance);
      }
      case "opaque":
        // No structural information — can't compare safely without resolving,
        // and resolving may dereference unbuilt sources. Treat as unequal so
        // the caller takes the rebuild path instead of crashing.
        return false;
    }
  }

  private static axisSourceEquals(
    a: Axis | AxisLazySource,
    b: Axis | AxisLazySource,
    tolerance: number,
  ): boolean {
    if (isAxisLazySource(a)) {
      if (!isAxisLazySource(b)) {
        return false;
      }
      if (a === b) {
        return true;
      }
      if (typeof a.compareTo === "function" && typeof b.compareTo === "function") {
        return a.compareTo(b);
      }
      return false;
    }
    if (isAxisLazySource(b)) {
      return false;
    }
    return a.equals(b, tolerance);
  }

  private static planeSourceEquals(
    a: Plane | PlaneLazySource,
    b: Plane | PlaneLazySource,
    tolerance: number,
  ): boolean {
    if (isPlaneLazySource(a)) {
      if (!isPlaneLazySource(b)) {
        return false;
      }
      if (a === b) {
        return true;
      }
      if (typeof a.compareTo === "function" && typeof b.compareTo === "function") {
        return a.compareTo(b);
      }
      return false;
    }
    if (isPlaneLazySource(b)) {
      return false;
    }
    return a.compareTo(b, tolerance);
  }

  static of(matrix: Matrix4): LazyMatrix {
    return new LazyMatrix(() => matrix, { kind: "eager", matrix }, matrix);
  }

  static from(resolver: () => Matrix4): LazyMatrix {
    return new LazyMatrix(resolver, { kind: "opaque" });
  }

  static mirror(plane: Plane | PlaneLazySource): LazyMatrix {
    if (isPlaneLazySource(plane)) {
      return new LazyMatrix(() => {
        const p = plane.getPlane();
        return Matrix4.mirrorPlane(p.normal, p.origin);
      }, { kind: "mirror", plane });
    }
    const matrix = Matrix4.mirrorPlane(plane.normal, plane.origin);
    return new LazyMatrix(() => matrix, { kind: "mirror", plane }, matrix);
  }

  static rotation(axis: Axis | AxisLazySource, angle: number): LazyMatrix {
    if (isAxisLazySource(axis)) {
      return new LazyMatrix(() => {
        const a = axis.getAxis();
        return Matrix4.fromRotationAroundAxis(a.origin, a.direction, angle);
      }, { kind: "rotation", axis, angle });
    }
    const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, angle);
    return new LazyMatrix(() => matrix, { kind: "rotation", axis, angle }, matrix);
  }

  static translation(axis: Axis | AxisLazySource, distance: number): LazyMatrix {
    if (isAxisLazySource(axis)) {
      return new LazyMatrix(() => {
        const dir = axis.getAxis().direction;
        return Matrix4.fromTranslation(dir.x * distance, dir.y * distance, dir.z * distance);
      }, { kind: "translation", axis, distance });
    }
    const dir = axis.direction;
    const matrix = Matrix4.fromTranslation(dir.x * distance, dir.y * distance, dir.z * distance);
    return new LazyMatrix(() => matrix, { kind: "translation", axis, distance }, matrix);
  }
}
