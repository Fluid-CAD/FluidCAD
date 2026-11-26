import type { gp_Pln, gp_Cylinder, gp_Cone, TopAbs_ShapeEnum, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { Convert } from "./convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { mmTol } from "../units/tolerance.js";
import { SurfaceFrame, SurfaceFrames } from "./surface-frames.js";
import { SurfaceClass, SurfaceClassifier } from "./surface-classifier.js";
import { CurveClassifier } from "./curve-classifier.js";

/**
 * What `facing()` reads off one face, kept per wrapper. A wrapper's OC
 * shape never changes while it lives, so the answer holds for its lifetime.
 * What depends on the face's class (the rim walks) is kept with the class
 * instead; see {@link SurfaceClassifier.derived}.
 */
type SurfaceFacts = {
  /** The outward normal at the face's UV centre; null where it is undefined. */
  centreNormal?: Vector3d | null;
};

const surfaceFacts = new WeakMap<Shape, SurfaceFacts>();

function surfaceFactsOf(face: Shape): SurfaceFacts {
  let facts = surfaceFacts.get(face);
  if (!facts) {
    facts = {};
    surfaceFacts.set(face, facts);
  }
  return facts;
}

export class FaceQuery {
  // Wrapper methods (public API for external callers)

  /** {@link isCircleFaceRaw}, answered from the wrapper's cached class. */
  static isCircleFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isCircleOf(FaceQuery.classOf(face), face.getShape(), diameter);
  }

  /** {@link isConeFaceRaw}, answered from the wrapper's cached class. */
  static isConeFace(face: Shape): boolean {
    return FaceQuery.classOf(face).kind === 'cone';
  }

  /** {@link isCylinderFaceRaw}, answered from the wrapper's cached class and rim. */
  static isCylinderFace(face: Shape, diameter?: number): boolean {
    if (!FaceQuery.isCylinderOf(FaceQuery.classOf(face), diameter)) {
      return false;
    }
    return FaceQuery.hasClosedCircularRim(face);
  }

  /** {@link isCylinderCurveFaceRaw}, answered from the wrapper's cached class and rim. */
  static isCylinderCurveFace(face: Shape, diameter?: number): boolean {
    if (!FaceQuery.isCylinderOf(FaceQuery.classOf(face), diameter)) {
      return false;
    }
    return !FaceQuery.hasClosedCircularRim(face);
  }

  /** The wrapper's {@link SurfaceClassifier} class, kept per wrapper there. */
  private static classOf(face: Shape): SurfaceClass {
    return SurfaceClassifier.classify(face as Face);
  }

  /**
   * {@link hasClosedCircularRimRaw}, read off the wrapper's edges and their
   * cached classes, and kept with the face's class.
   */
  static hasClosedCircularRim(face: Shape): boolean {
    return SurfaceClassifier.derived(face as Face, 'closedRim', () =>
      (face as Face).getEdges().some(edge => CurveClassifier.classify(edge).kind === 'circle'));
  }

  /** {@link isSphereFaceRaw}, answered from the wrapper's cached class. */
  static isSphereFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isSphereOf(FaceQuery.classOf(face), diameter);
  }

  /**
   * The face's outward unit normal at the centre of its UV bounds (see
   * {@link FaceOps.outwardNormalRaw}), kept per wrapper; null where the
   * normal is undefined. The face must carry its orientation in its body.
   */
  static centreNormal(face: Shape): Vector3d | null {
    const facts = surfaceFactsOf(face);
    if (facts.centreNormal === undefined) {
      facts.centreNormal = FaceOps.outwardNormalRaw(face.getShape() as TopoDS_Face);
    }
    return facts.centreNormal;
  }

  /** {@link isTorusFaceRaw}, answered from the wrapper's cached class. */
  static isTorusFace(face: Shape, majorRadius?: number, minorRadius?: number): boolean {
    return FaceQuery.isTorusOf(FaceQuery.classOf(face), majorRadius, minorRadius);
  }

  static isFaceOnPlane(face: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceQuery.isFaceOnPlaneRaw(face.getShape(), gpPln);
    dispose();
    return result;
  }

  static doesFaceIntersectPlane(face: Shape, plane: Plane): boolean {
    const oc = getOC();
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const planeFace = FaceOps.makeFaceFromPlane(gpPln);

    const tool = new oc.IntTools_FaceFace();
    const typed = oc.TopoDS.Face(face.getShape());
    tool.Perform(typed, planeFace, false);

    let result = false;
    if (tool.IsDone()) {
      result = tool.Lines().Length() > 0 || tool.Points().Length() > 0;
    }

    tool.delete();
    typed.delete();
    planeFace.delete();
    dispose();
    return result;
  }

  /** {@link isFaceParallelToPlaneRaw}, answered from the wrapper's cached class. */
  static isFaceParallelToPlane(face: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceQuery.isParallelOf(FaceQuery.classOf(face), gpPln);
    dispose();
    return result;
  }

  /** {@link isPlanarFaceRaw}, answered from the wrapper's cached class. */
  static isPlanarFace(face: Shape): boolean {
    return FaceQuery.classOf(face).kind === 'plane';
  }

  /** {@link getSurfaceTypeRaw}, answered from the wrapper's cached class. */
  static getSurfaceType(face: Shape): string {
    return FaceQuery.surfaceTypeOf(FaceQuery.classOf(face));
  }

  // Geometry readers. Each rebuilds the plane, cylinder or cone from the
  // face's class (kept per wrapper: a recovered face is recovered once,
  // however many of these are asked) and throws for a face of another kind.

  static getSurfacePlane(face: Shape): Plane {
    return Convert.toPlane(FaceQuery.gpPlaneOf(face), true);
  }

  static areFacePlanesParallel(face1: Shape, face2: Shape): boolean {
    const plane1 = FaceQuery.gpPlaneOf(face1);
    const plane2 = FaceQuery.gpPlaneOf(face2);
    const result = FaceQuery.arePlanesParallelRaw(plane1, plane2);
    plane1.delete();
    plane2.delete();
    return result;
  }

  /**
   * True when both faces lie on the same underlying surface — coplanar
   * planes, coaxial equal-radius cylinders, coaxial cones sharing apex and
   * semi-angle, or the same sphere or torus. Trim and orientation
   * differences are ignored: this is surface identity, for consumers that
   * resolve the infinite surface rather than the bounded face. A surface
   * recovered from a B-spline (see {@link SurfaceClassifier}) compares like
   * a native one, within the tolerance it was recovered at; free-form faces
   * are never the same surface as another face.
   */
  static isSameSurface(face1: Shape, face2: Shape): boolean {
    const a = FaceQuery.classOf(face1);
    const b = FaceQuery.classOf(face2);
    if (a.kind !== b.kind || !SurfaceClassifier.isAnalytic(a.kind)) {
      return false;
    }
    // Distances (plane offset, radius, apex, axis offset): 1e-7 mm in the
    // active unit between native surfaces, the recovery tolerance once
    // either was recovered. The angular bounds are unit-free.
    const recovered = a.recovered || b.recovered;
    const tolerance = recovered ? SurfaceClassifier.tolerance() : mmTol(1e-7);
    const angular = recovered ? FaceQuery.RECOVERED_ANGULAR_TOLERANCE : 1e-7;
    const axisAngular = recovered ? FaceQuery.RECOVERED_ANGULAR_TOLERANCE : 1e-9;
    if (a.kind === 'plane') {
      if (!a.origin || !a.normal || !b.origin || !b.normal) {
        return false;
      }
      return a.normal.isParallelTo(b.normal, angular)
        && Math.abs(b.origin.subtract(a.origin).toVector3d().dot(a.normal.normalize())) <= tolerance;
    }
    if (a.kind === 'cylinder') {
      if (a.radius === undefined || b.radius === undefined || !a.axis || !b.axis) {
        return false;
      }
      return Math.abs(a.radius - b.radius) < tolerance
        && FaceQuery.areAxesCollinear(a.axis, b.axis, tolerance, axisAngular);
    }
    if (a.kind === 'cone') {
      if (a.semiAngle === undefined || b.semiAngle === undefined || !a.apex || !b.apex || !a.axis || !b.axis) {
        return false;
      }
      return Math.abs(Math.abs(a.semiAngle) - Math.abs(b.semiAngle)) < (recovered ? angular : 1e-9)
        && a.apex.distanceTo(b.apex) < tolerance
        && FaceQuery.areAxesCollinear(a.axis, b.axis, tolerance, axisAngular);
    }
    // A sphere's frame is only a parametrization — two faces of one sphere
    // may carry any pole axis (a rotated copy, a mirrored half) — and a
    // torus is its axis and two radii: compare the geometry the frames
    // define, handedness aside.
    const frameA = FaceQuery.frameOf(a);
    const frameB = FaceQuery.frameOf(b);
    return frameA !== null && frameB !== null
      && SurfaceFrames.same(frameA, frameB, { lin: tolerance, ang: angular });
  }

  /**
   * How far apart the directions of two recovered surfaces may be and still
   * be one surface: recovery fits the frame to the B-spline's poles, which
   * lands it within a few 1e-15 of the original on the models measured.
   */
  private static readonly RECOVERED_ANGULAR_TOLERANCE = 1e-6;

  /** The frame a sphere or torus class defines, in the form {@link SurfaceFrames.same} compares. */
  private static frameOf(surface: SurfaceClass): SurfaceFrame | null {
    if (surface.kind === 'sphere' && surface.center && surface.radius !== undefined) {
      const { x, y, z } = surface.center;
      return { type: 'sphere', direct: true, loc: [x, y, z], xdir: [1, 0, 0], radius: surface.radius, extra: 0 };
    }
    if (surface.kind === 'torus' && surface.axis && surface.majorRadius !== undefined && surface.minorRadius !== undefined) {
      const { origin, direction } = surface.axis;
      return {
        type: 'torus',
        direct: true,
        loc: [origin.x, origin.y, origin.z],
        dir: [direction.x, direction.y, direction.z],
        xdir: [1, 0, 0],
        radius: surface.majorRadius,
        extra: surface.minorRadius,
      };
    }
    return null;
  }

  /** Collinear = parallel directions (either sense) with origins on one line. */
  private static areAxesCollinear(
    a: { origin: Point; direction: Vector3d },
    b: { origin: Point; direction: Vector3d },
    tolerance: number,
    angular: number,
  ): boolean {
    if (!a.direction.isParallelTo(b.direction, angular)) {
      return false;
    }
    const offset = b.origin.subtract(a.origin).toVector3d();
    return offset.cross(a.direction.normalize()).length() < tolerance;
  }

  static getSignedPlaneDistance(startFace: Shape, targetFace: Shape): number {
    const startPlane = FaceQuery.gpPlaneOf(startFace);
    const targetPlane = FaceQuery.gpPlaneOf(targetFace);
    const result = FaceQuery.getSignedPlaneDistanceRaw(startPlane, targetPlane);
    startPlane.delete();
    targetPlane.delete();
    return result;
  }

  static findFarthestCornerDistanceFromFace(targetFace: Shape, sourceFace: Shape): number {
    const sourcePlane = FaceQuery.gpPlaneOf(sourceFace);
    const result = FaceQuery.findFarthestCornerDistanceRaw(targetFace.getShape(), sourcePlane);
    sourcePlane.delete();
    return result;
  }

  static makeInfinitePlanarFace(face: Shape, offset?: number, offsetDirection?: Vector3d): Face {
    const gpPln = FaceQuery.gpPlaneOf(face);

    if (offset && offsetDirection) {
      const [vec, disposeVec] = Convert.toGpVec(offsetDirection);
      vec.Multiply(offset);
      gpPln.Translate(vec);
      disposeVec();
    }

    const rawFace = FaceOps.makeFaceFromPlane(gpPln);
    gpPln.delete();
    return Face.fromTopoDSFace(rawFace);
  }

  static makeInfiniteCylindricalFace(face: Shape, offset?: number): Face {
    const oc = getOC();
    const cylinder = FaceQuery.gpCylinderOf(face);
    const cylMaker = new oc.gce_MakeCylinder(cylinder, offset || 0);
    const rawFace = FaceOps.makeFaceFromCylinder(cylMaker.Value());
    cylinder.delete();
    cylMaker.delete();
    return Face.fromTopoDSFace(rawFace);
  }

  static makeInfiniteConicalFace(face: Shape, offset?: number): Face {
    const cone = FaceQuery.gpConeOf(face);
    if (offset) {
      // The parallel surface at normal distance `offset` is the coaxial cone
      // with the same semi-angle and a reference radius enlarged by
      // offset / cos(semiAngle).
      const radius = cone.RefRadius() + offset / Math.cos(cone.SemiAngle());
      if (radius < 0) {
        cone.delete();
        throw new Error("endOffset is too large for the conical target face");
      }
      cone.SetRadius(radius);
    }
    const rawFace = FaceOps.makeFaceFromCone(cone);
    cone.delete();
    return Face.fromTopoDSFace(rawFace);
  }

  /** The face's plane for OCCT, native or recovered; the caller deletes it. Throws for a face that is no plane. */
  static gpPlaneOf(face: Shape): gp_Pln {
    return SurfaceClassifier.gpPlane(FaceQuery.classOf(face));
  }

  /** The face's cylinder for OCCT, native or recovered; the caller deletes it. Throws for a face that is no cylinder. */
  static gpCylinderOf(face: Shape): gp_Cylinder {
    return SurfaceClassifier.gpCylinder(FaceQuery.classOf(face));
  }

  /** The face's cone for OCCT, native or recovered; the caller deletes it. Throws for a face that is no cone. */
  static gpConeOf(face: Shape): gp_Cone {
    return SurfaceClassifier.gpCone(FaceQuery.classOf(face));
  }

  /**
   * The V-bounds of `face` on its surface. For a cylindrical surface V is
   * the axial coordinate; for a conical surface V is along the slant
   * (caller multiplies by `cos(semiAngle)` to get axial Z). A cylinder or
   * cone recovered from a B-spline reports the V-bounds its boundary spans
   * on the recovered surface.
   */
  static getSurfaceVBounds(face: Shape): { vMin: number; vMax: number } {
    const surface = FaceQuery.classOf(face);
    if (surface.recovered && surface.axis && (surface.kind === 'cylinder' || surface.kind === 'cone')) {
      const slant = surface.kind === 'cone' ? Math.cos(surface.semiAngle ?? 0) : 1;
      const { origin, direction } = surface.axis;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (const point of FaceQuery.boundarySamples(face.getShape())) {
        const v = point.subtract(origin).toVector3d().dot(direction) / slant;
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
      return { vMin, vMax };
    }
    const oc = getOC();
    const typed = oc.TopoDS.Face(face.getShape());
    const adaptor = new oc.BRepAdaptor_Surface(typed, true);
    try {
      return { vMin: adaptor.FirstVParameter(), vMax: adaptor.LastVParameter() };
    } finally {
      adaptor.delete();
      typed.delete();
    }
  }

  /** Points along every boundary edge of a face, its vertices included. */
  private static boundarySamples(face: TopoDS_Shape): Point[] {
    const oc = getOC();
    const steps = 8;
    return Explorer.withShapes(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges => {
      const points: Point[] = [];
      for (const edge of edges) {
        const typed = oc.TopoDS.Edge(edge);
        const adaptor = new oc.BRepAdaptor_Curve(typed);
        typed.delete();
        const first = adaptor.FirstParameter();
        const last = adaptor.LastParameter();
        for (let i = 0; i <= steps; i++) {
          points.push(Convert.toPoint(adaptor.Value(first + ((last - first) * i) / steps), true));
        }
        adaptor.delete();
      }
      return points;
    });
  }

  // Raw methods (for oc-internal and common/ use). Each classifies the face
  // afresh through SurfaceClassifier; the wrapper forms above read the class
  // kept per wrapper.

  /**
   * A flat, disc-shaped face: planar (see {@link SurfaceClassifier}), its
   * edges circles or arcs (see {@link CurveClassifier}), one of them a full
   * circle of the given diameter when one is asked for.
   */
  static isCircleFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    return FaceQuery.isCircleOf(SurfaceClassifier.classifyRaw(face), face, diameter);
  }

  private static isCircleOf(surface: SurfaceClass, face: TopoDS_Shape, diameter?: number): boolean {
    if (surface.kind !== 'plane') {
      return false;
    }
    const oc = getOC();
    // The explorer copies are this read's own.
    return Explorer.withShapes(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges => {
      for (const edge of edges) {
        const curve = CurveClassifier.classifyRaw(edge);
        if (curve.kind !== 'circle' && curve.kind !== 'arc') {
          return false;
        }
        if (curve.kind === 'circle') {
          if (diameter === undefined) {
            return true;
          }
          const tolerance = curve.recovered ? CurveClassifier.tolerance() : oc.Precision.Confusion();
          return Math.abs((curve.radius ?? 0) - diameter / 2) <= tolerance;
        }
      }
      return false;
    });
  }

  static isConeFaceRaw(face: TopoDS_Shape): boolean {
    return SurfaceClassifier.classifyRaw(face).kind === 'cone';
  }

  /**
   * Whether a cylindrical face wraps all the way around its axis: it then
   * carries at least one closed circular edge (a rim; see
   * {@link CurveClassifier}, so a B-spline rim counts). Partial wraps — a
   * fillet, a rounded pad corner, a bore cut open by a slot — have none;
   * their bounding edges are lines, arcs, ellipses or B-splines depending
   * on the adjacent geometry. This is the one rule that splits
   * `face().cylinder()` from `face().cylinderCurve()`, and what the
   * selection probes read so synthesis offers the filter that admits the pick.
   */
  static hasClosedCircularRimRaw(face: TopoDS_Shape): boolean {
    const oc = getOC();
    // The explorer copies are this read's own.
    return Explorer.withShapes(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges =>
      edges.some(edge => CurveClassifier.classifyRaw(edge).kind === 'circle'));
  }

  /**
   * The radius of a cylindrical face's surface (native or recovered), or
   * null when the face is not a cylinder. Reads the surface itself, so a
   * partial wrap with no circular rim still reports its radius.
   */
  static cylinderRadiusRaw(face: TopoDS_Shape): number | null {
    const surface = SurfaceClassifier.classifyRaw(face);
    return surface.kind === 'cylinder' ? surface.radius ?? null : null;
  }

  /**
   * A cylinder of the given diameter, if one is asked for: to OCCT's own
   * precision for a native cylinder, to the recovery tolerance for one
   * recovered from a B-spline.
   */
  private static isCylinderOf(surface: SurfaceClass, diameter?: number): boolean {
    if (surface.kind !== 'cylinder' || surface.radius === undefined) {
      return false;
    }
    return diameter === undefined || Math.abs(surface.radius - diameter / 2) <= FaceQuery.sizeTolerance(surface);
  }

  /** How closely a face's radius must match a requested one; see {@link isCylinderOf}. */
  private static sizeTolerance(surface: SurfaceClass): number {
    return surface.recovered ? SurfaceClassifier.tolerance() : getOC().Precision.Confusion();
  }

  /** A full cylindrical face (see {@link hasClosedCircularRimRaw}), optionally of the given diameter. */
  static isCylinderFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    if (!FaceQuery.isCylinderOf(SurfaceClassifier.classifyRaw(face), diameter)) {
      return false;
    }
    return FaceQuery.hasClosedCircularRimRaw(face);
  }

  /** A partial cylindrical face (see {@link hasClosedCircularRimRaw}), optionally of the given diameter. */
  static isCylinderCurveFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    if (!FaceQuery.isCylinderOf(SurfaceClassifier.classifyRaw(face), diameter)) {
      return false;
    }
    return !FaceQuery.hasClosedCircularRimRaw(face);
  }

  /** A spherical face (native or recovered), optionally of the given diameter. */
  static isSphereFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    return FaceQuery.isSphereOf(SurfaceClassifier.classifyRaw(face), diameter);
  }

  /** A sphere whose diameter matches a requested one within {@link SurfaceClassifier.tolerance}. */
  private static isSphereOf(surface: SurfaceClass, diameter?: number): boolean {
    if (surface.kind !== 'sphere' || surface.radius === undefined) {
      return false;
    }
    return diameter === undefined || Math.abs(surface.radius * 2 - diameter) <= SurfaceClassifier.tolerance();
  }

  static isTorusFaceRaw(face: TopoDS_Shape, majorRadius?: number, minorRadius?: number): boolean {
    return FaceQuery.isTorusOf(SurfaceClassifier.classifyRaw(face), majorRadius, minorRadius);
  }

  private static isTorusOf(surface: SurfaceClass, majorRadius?: number, minorRadius?: number): boolean {
    if (surface.kind !== 'torus') {
      return false;
    }
    const tolerance = FaceQuery.sizeTolerance(surface);
    if (majorRadius !== undefined && Math.abs((surface.majorRadius ?? 0) - majorRadius) > tolerance) {
      return false;
    }
    if (minorRadius !== undefined && Math.abs((surface.minorRadius ?? 0) - minorRadius) > tolerance) {
      return false;
    }
    return true;
  }

  static isFaceOnPlaneRaw(face: TopoDS_Shape, plane: gp_Pln): boolean {
    const oc = getOC();
    const typed = oc.TopoDS.Face(face);
    try {
      return FaceOps.faceOnPlane(typed, plane);
    } finally {
      typed.delete();
    }
  }

  /** A planar face (native or recovered) whose normal is parallel to `plane`'s. Curved faces never are. */
  static isFaceParallelToPlaneRaw(face: TopoDS_Shape, plane: gp_Pln): boolean {
    return FaceQuery.isParallelOf(SurfaceClassifier.classifyRaw(face), plane);
  }

  private static isParallelOf(surface: SurfaceClass, plane: gp_Pln): boolean {
    if (surface.kind !== 'plane' || !surface.normal) {
      return false;
    }
    const oc = getOC();
    const { x, y, z } = surface.normal;
    const faceNormal = new oc.gp_Dir(x, y, z);
    const targetAxis = plane.Axis();
    const targetNormal = targetAxis.Direction();
    const result = faceNormal.IsParallel(targetNormal, oc.Precision.Angular());
    targetNormal.delete();
    targetAxis.delete();
    faceNormal.delete();
    return result;
  }

  static isPlanarFaceRaw(face: TopoDS_Shape): boolean {
    return SurfaceClassifier.classifyRaw(face).kind === 'plane';
  }

  /**
   * The face's surface kind (see {@link SurfaceClassifier}): `plane`,
   * `cylinder`, `cone`, `sphere` or `torus` — native or recovered from a
   * B-spline — else `other`.
   */
  static getSurfaceTypeRaw(face: TopoDS_Shape): string {
    return FaceQuery.surfaceTypeOf(SurfaceClassifier.classifyRaw(face));
  }

  private static surfaceTypeOf(surface: SurfaceClass): string {
    return SurfaceClassifier.isAnalytic(surface.kind) ? surface.kind : 'other';
  }

  static findFarthestCornerDistanceRaw(face: TopoDS_Shape, plane: gp_Pln): number {
    const oc = getOC();
    const bbox = new oc.Bnd_Box();
    oc.BRepBndLib.Add(face, bbox, true);
    const minPnt = bbox.CornerMin();
    const maxPnt = bbox.CornerMax();
    bbox.delete();

    const corners = [
      new oc.gp_Pnt(minPnt.X(), minPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), minPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), maxPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), minPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), maxPnt.Y(), minPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), minPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(minPnt.X(), maxPnt.Y(), maxPnt.Z()),
      new oc.gp_Pnt(maxPnt.X(), maxPnt.Y(), maxPnt.Z())
    ];

    const planeAxis = plane.Axis();
    const planePoint = planeAxis.Location();
    const planeNormal = planeAxis.Direction();

    let maxDistance = 0;

    for (const corner of corners) {
      const vectorToPoint = new oc.gp_Vec(planePoint, corner);
      const distance = vectorToPoint.Dot(new oc.gp_Vec(planeNormal));

      if (!maxDistance || Math.abs(distance) > Math.abs(maxDistance)) {
        maxDistance = distance;
      }

      vectorToPoint.delete();
      corner.delete();
    }

    planeAxis.delete();
    planePoint.delete();
    planeNormal.delete();

    return maxDistance;
  }

  static arePlanesParallelRaw(plane1: gp_Pln, plane2: gp_Pln): boolean {
    const oc = getOC();
    // The axes are copies of their own, as are the directions read off them.
    const axis1 = plane1.Axis();
    const axis2 = plane2.Axis();
    const dir1 = axis1.Direction();
    const dir2 = axis2.Direction();
    const result = dir1.IsParallel(dir2, oc.Precision.Angular());
    dir1.delete();
    dir2.delete();
    axis1.delete();
    axis2.delete();
    return result;
  }

  static getSignedPlaneDistanceRaw(startPlane: gp_Pln, targetPlane: gp_Pln): number {
    const startPlanePosition = startPlane.Location();
    const targetPlanePosition = targetPlane.Location();

    let normalizedStart = Convert.toVector3dFromGpPnt(startPlanePosition);
    if (normalizedStart.length() === 0) {
      const normal = startPlane.Axis().Direction();
      normalizedStart = Convert.toVector3dFromGpDir(normal).normalize();
      normal.delete();
    } else {
      normalizedStart = normalizedStart.normalize();
    }

    let normalizedTarget = Convert.toVector3dFromGpPnt(targetPlanePosition);
    if (normalizedTarget.length() === 0) {
      const normal = targetPlane.Axis().Direction();
      normalizedTarget = Convert.toVector3dFromGpDir(normal).normalize();
      normal.delete();
    } else {
      normalizedTarget = normalizedTarget.normalize();
    }

    const dot = normalizedStart.dot(normalizedTarget);

    let distance = startPlane.Distance(targetPlane);
    if (dot < 0) {
      distance = -distance;
    }

    startPlanePosition.delete();
    targetPlanePosition.delete();
    return distance;
  }
}
