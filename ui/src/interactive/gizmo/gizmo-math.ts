import { Ray, Vector3 } from 'three';

/**
 * Pure drag math for the transform gizmo. Rays arrive pre-built from
 * `SceneContext.createPickingRaycaster`, so the ortho camera's pushed-back
 * ray origin is already handled — everything here is origin-translation
 * invariant along the ray direction and works identically for both cameras.
 */
export class GizmoMath {
  /** Ray directions closer to parallel with the axis than this are degenerate. */
  private static readonly AXIS_PARALLEL_EPSILON = 1e-4;
  /** Rays flatter against a plane than this cosine are degenerate (edge-on). */
  private static readonly PLANE_EDGE_ON_COSINE = 0.05;

  private static readonly TRANSLATE_SNAP_MM = 1;
  private static readonly ROTATE_SNAP_DEG = 5;

  /**
   * Parameter `t` of the closest point on the line `origin + t·axisDir` to
   * `ray`, or null when the ray runs (nearly) parallel to the axis — there
   * the closest point races to infinity and a drag would jump.
   */
  static closestAxisParam(ray: Ray, origin: Vector3, axisDir: Vector3): number | null {
    const a = axisDir.clone().normalize();
    const rd = ray.direction.clone().normalize();
    const b = a.dot(rd);
    const denom = 1 - b * b;
    if (Math.abs(denom) < GizmoMath.AXIS_PARALLEL_EPSILON) {
      return null;
    }
    const w0 = ray.origin.clone().sub(origin);
    return (a.dot(w0) - b * rd.dot(w0)) / denom;
  }

  /**
   * Intersection of `ray` with the plane through `origin` with `normal`, or
   * null when the ray grazes the plane edge-on or the plane lies behind the
   * ray origin.
   */
  static intersectPlane(ray: Ray, origin: Vector3, normal: Vector3): Vector3 | null {
    const n = normal.clone().normalize();
    const rd = ray.direction.clone().normalize();
    const denom = rd.dot(n);
    if (Math.abs(denom) < GizmoMath.PLANE_EDGE_ON_COSINE) {
      return null;
    }
    const t = origin.clone().sub(ray.origin).dot(n) / denom;
    if (t < 0) {
      return null;
    }
    return ray.origin.clone().addScaledVector(rd, t);
  }

  /**
   * Angle (degrees) of the ray's hit in the rotation plane through `origin`
   * (normal `normal`), measured from the in-plane basis `u` toward `v` —
   * with (u, v, normal) right-handed, positive angles follow the right-hand
   * rule about `normal`.
   */
  static rotationAngleDeg(
    ray: Ray,
    origin: Vector3,
    normal: Vector3,
    u: Vector3,
    v: Vector3,
  ): number | null {
    const hit = GizmoMath.intersectPlane(ray, origin, normal);
    if (!hit) {
      return null;
    }
    const w = hit.sub(origin);
    if (w.lengthSq() < 1e-12) {
      return null;
    }
    return (Math.atan2(w.dot(v), w.dot(u)) * 180) / Math.PI;
  }

  /**
   * Accumulate the raw plane angle `next` onto `prevAccum`, unwrapping the
   * atan2 seam so a drag can wind past ±180° without jumping.
   */
  static unwrapDeg(prevRaw: number, next: number, prevAccum: number): { raw: number; accum: number } {
    let delta = next - prevRaw;
    delta -= 360 * Math.round(delta / 360);
    return { raw: next, accum: prevAccum + delta };
  }

  /** 1 mm grid when `on`; pass-through otherwise. */
  static snapTranslate(mm: number, on: boolean): number {
    if (!on) {
      return mm;
    }
    return Math.round(mm / GizmoMath.TRANSLATE_SNAP_MM) * GizmoMath.TRANSLATE_SNAP_MM;
  }

  /** 5° grid when `on`; pass-through otherwise. */
  static snapRotate(deg: number, on: boolean): number {
    if (!on) {
      return deg;
    }
    return Math.round(deg / GizmoMath.ROTATE_SNAP_DEG) * GizmoMath.ROTATE_SNAP_DEG;
  }
}
