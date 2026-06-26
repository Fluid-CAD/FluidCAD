import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";

const EPSILON = 1e-9;
const DIRECTION_EPSILON = 1e-6;

export interface UV {
  u: number;
  v: number;
}

/** Geometry of a cylindrical target surface, extracted from its `gp_Cylinder`. */
export interface CylinderSpec {
  origin: Point;
  axisDir: Vector3d;
  radius: number;
}

/** Geometry of a conical target surface, extracted from its `gp_Cone`. */
export interface ConeSpec {
  origin: Point;
  axisDir: Vector3d;
  /** Radius in the frame's reference plane (at v = 0). */
  refRadius: number;
  /** Cone half-angle. Negative angles are normalized by reversing the axis. */
  semiAngle: number;
}

export type Development = CylinderDevelopment | ConeDevelopment;

/**
 * Computes the anchor frame of a development: the sketch plane origin is
 * projected radially onto the surface, and the frame's X direction points
 * from the axis toward that anchor so the anchor sits at u = 0.
 */
function anchorFrame(origin: Point, axisDir: Vector3d, plane: Plane): { xDir: Vector3d; z0: number } {
  const toPlaneOrigin = origin.vectorTo(plane.origin);
  const z0 = toPlaneOrigin.dot(axisDir);
  const radial = toPlaneOrigin.subtract(axisDir.multiply(z0));
  if (radial.length() < EPSILON) {
    throw new Error("wrap(): the sketch plane origin must not lie on the target surface axis");
  }
  return { xDir: radial.normalize(), z0 };
}

/**
 * Isometric (arc-length preserving) development of a sketch plane onto a
 * developable surface — a true wrap, not a projection.
 *
 * The mapping is anchored at the sketch plane origin: its radial projection
 * onto the surface becomes the anchor point, and the surface frame is
 * recentered so the anchor sits at u = 0, keeping wrapped geometry away from
 * the parametric seam.
 *
 * In-plane orientation is derived from the surface rather than assumed: the
 * projection of the surface meridian onto the sketch plane maps to +v, and
 * the perpendicular in-plane direction maps to +u with its sign matched to
 * the projection of the surface's +u tangent. For the canonical sketch on a
 * tangent plane this is the exact development; for tilted planes it degrades
 * gracefully to the nearest isometry.
 */
export abstract class SurfaceDevelopment {
  /** Frame origin (on the surface axis). */
  readonly origin: Point;
  /** Frame Z — the surface axis. */
  readonly axisDir: Vector3d;
  /** Frame X — points from the axis toward the sketch anchor (u = 0). */
  readonly xDir: Vector3d;
  /** Frame Y — completes the right-handed frame (+u tangent at the anchor). */
  readonly yDir: Vector3d;

  /** In-plane unit direction (sketch coords) that maps to +u (around the surface). */
  private readonly sDir: Point2D;
  /** In-plane unit direction (sketch coords) that maps to +v (along the meridian). */
  private readonly hDir: Point2D;

  protected constructor(plane: Plane, origin: Point, axisDir: Vector3d, xDir: Vector3d, meridianDir: Vector3d) {
    this.origin = origin;
    this.axisDir = axisDir;
    this.xDir = xDir;
    this.yDir = axisDir.cross(xDir).normalize();

    this.hDir = SurfaceDevelopment.projectIntoPlane(plane, meridianDir,
      "wrap(): the sketch plane is perpendicular to the target surface axis");
    const uImage = SurfaceDevelopment.projectIntoPlane(plane, this.yDir,
      "wrap(): the sketch plane must not contain the target surface axis");
    const perp = new Point2D(-this.hDir.y, this.hDir.x);
    const towardU = perp.x * uImage.x + perp.y * uImage.y;
    this.sDir = towardU >= 0 ? perp : new Point2D(-perp.x, -perp.y);
  }

  private static projectIntoPlane(plane: Plane, dir: Vector3d, errorMessage: string): Point2D {
    const inPlane = dir.subtract(plane.normal.multiply(dir.dot(plane.normal)));
    if (inPlane.length() < DIRECTION_EPSILON) {
      throw new Error(errorMessage);
    }
    const unit = inPlane.normalize();
    return new Point2D(unit.dot(plane.xDirection), unit.dot(plane.yDirection));
  }

  /** Sketch-plane point → development coordinates (s along +u, h along +v). */
  protected develop(p: Point2D): { s: number; h: number } {
    return {
      s: p.x * this.sDir.x + p.y * this.sDir.y,
      h: p.x * this.hDir.x + p.y * this.hDir.y,
    };
  }

  /**
   * Whether the mapping preserves winding: a counter-clockwise loop in
   * sketch-plane coordinates (around the plane normal) stays counter-clockwise
   * in UV. The (s, h) basis decides it — the u and v scales are positive.
   */
  isOrientationPreserving(): boolean {
    return this.sDir.x * this.hDir.y - this.sDir.y * this.hDir.x > 0;
  }

  /** Maps a sketch-plane point to parameters on the recentered surface. */
  abstract toUV(p: Point2D): UV;
  /** Evaluates the recentered surface at the given parameters. */
  abstract evalPoint(uv: UV): Point;
  /** Normal distance from a 3D point to the surface. */
  abstract distanceTo(p: Point): number;
  /** Outward surface normal at (the radial projection of) the given point. */
  abstract surfaceNormalAt(p: Point): Vector3d;

  /** Decomposes a point into axial height and radial offset in the surface frame. */
  protected radialSplit(p: Point): { z: number; radialDist: number; radialDir: Vector3d } {
    const w = this.origin.vectorTo(p);
    const z = w.dot(this.axisDir);
    const radial = w.subtract(this.axisDir.multiply(z));
    const radialDist = radial.length();
    const radialDir = radialDist < EPSILON ? this.xDir : radial.normalize();
    return { z, radialDist, radialDir };
  }
}

export class CylinderDevelopment extends SurfaceDevelopment {
  readonly kind = 'cylinder' as const;
  readonly radius: number;
  /** Axial height of the sketch anchor in the surface frame. */
  private readonly v0: number;

  constructor(spec: CylinderSpec, plane: Plane) {
    const axisDir = spec.axisDir.normalize();
    const { xDir, z0 } = anchorFrame(spec.origin, axisDir, plane);
    super(plane, spec.origin, axisDir, xDir, axisDir);
    this.radius = spec.radius;
    this.v0 = z0;
  }

  toUV(p: Point2D): UV {
    const { s, h } = this.develop(p);
    return { u: s / this.radius, v: this.v0 + h };
  }

  evalPoint(uv: UV): Point {
    return this.origin
      .add(this.xDir.multiply(this.radius * Math.cos(uv.u)))
      .add(this.yDir.multiply(this.radius * Math.sin(uv.u)))
      .add(this.axisDir.multiply(uv.v));
  }

  distanceTo(p: Point): number {
    return Math.abs(this.radialSplit(p).radialDist - this.radius);
  }

  surfaceNormalAt(p: Point): Vector3d {
    return this.radialSplit(p).radialDir;
  }
}

export class ConeDevelopment extends SurfaceDevelopment {
  readonly kind = 'cone' as const;
  readonly refRadius: number;
  readonly semiAngle: number;
  /** Slant distance from the apex to the v = 0 circle (= refRadius / sin(semiAngle)). */
  private readonly apexSlant: number;
  /** Slant distance from the apex to the sketch anchor. */
  private readonly anchorSlant: number;

  constructor(spec: ConeSpec, plane: Plane) {
    // Normalize to a positive half-angle so the slant grows with +v; a
    // negative gp_Cone angle describes the same surface with a reversed axis.
    let axisDir = spec.axisDir.normalize();
    let semiAngle = spec.semiAngle;
    if (semiAngle < 0) {
      axisDir = axisDir.negate();
      semiAngle = -semiAngle;
    }

    const { xDir, z0 } = anchorFrame(spec.origin, axisDir, plane);
    const meridianDir = xDir.multiply(Math.sin(semiAngle)).add(axisDir.multiply(Math.cos(semiAngle)));
    super(plane, spec.origin, axisDir, xDir, meridianDir);

    this.refRadius = spec.refRadius;
    this.semiAngle = semiAngle;
    this.apexSlant = spec.refRadius / Math.sin(semiAngle);
    this.anchorSlant = this.apexSlant + z0 / Math.cos(semiAngle);
    if (this.anchorSlant < EPSILON) {
      throw new Error("wrap(): the sketch plane origin projects onto the apex of the conical target face");
    }
  }

  toUV(p: Point2D): UV {
    const { s, h } = this.develop(p);
    // The cone develops into a planar sector around the apex, which sits at
    // distance `anchorSlant` behind the sketch anchor along -h. Develop the
    // point in polar coordinates around it: slant = planar radius, surface
    // angle = planar angle / sin(semiAngle).
    const fromApexH = this.anchorSlant + h;
    const rho = Math.hypot(s, fromApexH);
    if (rho < EPSILON) {
      throw new Error("wrap(): the sketch extends across the apex of the conical target face");
    }
    const phi = Math.atan2(s, fromApexH);
    return { u: phi / Math.sin(this.semiAngle), v: rho - this.apexSlant };
  }

  evalPoint(uv: UV): Point {
    const r = this.refRadius + uv.v * Math.sin(this.semiAngle);
    return this.origin
      .add(this.xDir.multiply(r * Math.cos(uv.u)))
      .add(this.yDir.multiply(r * Math.sin(uv.u)))
      .add(this.axisDir.multiply(uv.v * Math.cos(this.semiAngle)));
  }

  distanceTo(p: Point): number {
    const { z, radialDist } = this.radialSplit(p);
    const surfaceRadius = this.refRadius + z * Math.tan(this.semiAngle);
    return Math.abs((radialDist - surfaceRadius) * Math.cos(this.semiAngle));
  }

  surfaceNormalAt(p: Point): Vector3d {
    const { radialDir } = this.radialSplit(p);
    return radialDir.multiply(Math.cos(this.semiAngle))
      .subtract(this.axisDir.multiply(Math.sin(this.semiAngle)));
  }
}
