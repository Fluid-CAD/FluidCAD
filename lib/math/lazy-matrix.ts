import { Matrix4 } from "./matrix4.js";
import { Axis } from "./axis.js";
import { Plane } from "./plane.js";

/** Anything that can be resolved to an `Axis` once built — e.g. `AxisObjectBase`. */
export interface AxisLazySource {
  getAxis(): Axis;
}

/** Anything that can be resolved to a `Plane` once built — e.g. `PlaneObjectBase`. */
export interface PlaneLazySource {
  getPlane(): Plane;
}

function isAxisLazySource(a: Axis | AxisLazySource): a is AxisLazySource {
  return typeof (a as AxisLazySource).getAxis === "function";
}

function isPlaneLazySource(p: Plane | PlaneLazySource): p is PlaneLazySource {
  return typeof (p as PlaneLazySource).getPlane === "function";
}

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

  private constructor(resolver: () => Matrix4, cached: Matrix4 | null = null) {
    this._resolver = resolver;
    this._cached = cached;
  }

  resolve(): Matrix4 {
    if (this._cached === null) {
      this._cached = this._resolver();
    }
    return this._cached;
  }

  equals(other: LazyMatrix, tolerance: number = 0): boolean {
    return this.resolve().equals(other.resolve(), tolerance);
  }

  static of(matrix: Matrix4): LazyMatrix {
    return new LazyMatrix(() => matrix, matrix);
  }

  static from(resolver: () => Matrix4): LazyMatrix {
    return new LazyMatrix(resolver);
  }

  static mirror(plane: Plane | PlaneLazySource): LazyMatrix {
    if (isPlaneLazySource(plane)) {
      return new LazyMatrix(() => {
        const p = plane.getPlane();
        return Matrix4.mirrorPlane(p.normal, p.origin);
      });
    }
    return LazyMatrix.of(Matrix4.mirrorPlane(plane.normal, plane.origin));
  }

  static rotation(axis: Axis | AxisLazySource, angle: number): LazyMatrix {
    if (isAxisLazySource(axis)) {
      return new LazyMatrix(() => {
        const a = axis.getAxis();
        return Matrix4.fromRotationAroundAxis(a.origin, a.direction, angle);
      });
    }
    return LazyMatrix.of(Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, angle));
  }

  static translation(axis: Axis | AxisLazySource, distance: number): LazyMatrix {
    if (isAxisLazySource(axis)) {
      return new LazyMatrix(() => {
        const dir = axis.getAxis().direction;
        return Matrix4.fromTranslation(dir.x * distance, dir.y * distance, dir.z * distance);
      });
    }
    const dir = axis.direction;
    return LazyMatrix.of(Matrix4.fromTranslation(dir.x * distance, dir.y * distance, dir.z * distance));
  }
}
