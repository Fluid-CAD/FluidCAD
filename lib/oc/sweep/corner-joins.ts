import type { TopoDS_Shape } from "ocjs-fluidcad";
import { BooleanOps } from "../boolean-ops.js";
import { Explorer } from "../explorer.js";
import { ExtrudeOps } from "../extrude-ops.js";
import { RevolveOps } from "../revolve-ops.js";
import { FaceOps } from "../face-ops.js";
import { Face } from "../../common/face.js";
import { Shape } from "../../common/shape.js";
import { Axis } from "../../math/axis.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import type { SpineCorner } from "./spine-analysis.js";

/**
 * The two ways two pipe legs are joined at a sharp spine corner.
 *
 * Mitre: each leg overshoots the corner and is trimmed back to the bisector
 * plane, so the legs meet along one shared curve — the joint Onshape draws.
 * Round: the incoming leg's end section is revolved about the corner axis
 * through the turn angle, filling the wedge between the two leg ends.
 */
export class CornerJoins {
  /** Bisector-plane normal: points into the incoming leg's overshoot. */
  static mitreNormal(corner: SpineCorner): Vector3d {
    return corner.inTangent.add(corner.outTangent).normalize();
  }

  /**
   * How far a mitre cut reaches along a leg from the corner: the farthest
   * section point (`radius` from the spine) meets the bisector plane
   * `radius · tan(angle / 2)` past the corner.
   */
  static mitreReach(corner: SpineCorner, radius: number): number {
    return radius * Math.tan(corner.angle / 2);
  }

  /**
   * Removes everything of `leg` on the far side of the plane through `point`
   * with `normal`, i.e. the overshoot beyond a mitre. `extent` bounds the
   * overshoot (section radius plus extension), sizing the cutter.
   */
  static trimBeyondPlane(leg: TopoDS_Shape, point: Point, normal: Vector3d, extent: number): TopoDS_Shape {
    const cutter = CornerJoins.halfSpace(point, normal, extent);
    try {
      return BooleanOps.cutShapesRaw(leg, cutter.getShape());
    } finally {
      cutter.dispose();
    }
  }

  /**
   * The wedge filling a round corner: the incoming leg's end section `cap`
   * revolved about the corner axis. The axis passes through the cap, which
   * MakeRevol refuses, so the cap is first split along the bend plane into
   * halves whose straight edge lies on the axis — each revolves cleanly (a
   * circle's halves make a true sphere).
   */
  static roundWedge(cap: TopoDS_Shape, corner: SpineCorner, extent: number): Shape[] {
    const bendNormal = corner.axis.cross(corner.inTangent).normalize();
    const axis = new Axis(corner.point, corner.axis);
    const halves = [bendNormal, bendNormal.negate()]
      .map(side => CornerJoins.trimBeyondPlane(cap, corner.point, side, extent));
    // The halves, their explorer copies and the profile wrappers only feed
    // the revolutions; the wedge solids are what lives on.
    try {
      return halves.flatMap(half =>
        Explorer.withShapes(half, Explorer.getOcShapeType("face"), faces => faces.map(raw => {
          const profile = Face.fromTopoDSFace(Explorer.toFace(raw));
          try {
            return RevolveOps.makeRevol(profile, axis, corner.angle, { history: false }).solid;
          } finally {
            profile.dispose();
          }
        })),
      );
    } finally {
      Explorer.deleteAll(halves);
    }
  }

  /**
   * A bounded stand-in for the half-space `(p - point) · normal > 0`: a
   * square prism starting on the plane, `2 · extent` deep and wide enough to
   * swallow anything within `extent` of `point`. Booleans get a tool the size
   * of the job, never a giant proxy for infinity.
   */
  private static halfSpace(point: Point, normal: Vector3d, extent: number): Shape {
    const size = 2 * extent;
    const face = Face.fromTopoDSFace(FaceOps.makeSquareFace(Plane.fromPointAndNormal(point, normal), size));
    try {
      // Only the solid is wanted; the profile and the prism's caps go.
      const { solid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(face, normal.normalize().multiply(size));
      firstFace.dispose();
      lastFace.dispose();
      return solid;
    } finally {
      face.dispose();
    }
  }
}
