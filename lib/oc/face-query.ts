import type { gp_Pln, gp_Cylinder, gp_Cone, TopAbs_ShapeEnum, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceOps } from "./face-ops.js";
import { ShapeOps } from "./shape-ops.js";
import { Convert } from "./convert.js";
import { Vector3d } from "../math/vector3d.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import type { Wire } from "../common/wire.js";
import { mmTol } from "../units/tolerance.js";
import { SurfaceFrame, SurfaceFrames } from "./surface-frames.js";
import { SurfaceClass, SurfaceClassifier } from "./surface-classifier.js";
import { CurveClass, CurveClassifier } from "./curve-classifier.js";

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

/** A circle bounding a flat face; see {@link FaceCircles}. */
export type FaceCircle = {
  center: Point;
  radius: number;
  /** True when an edge tracing it is a B-spline recovered as a circle, so its radius holds to the recovery tolerance only. */
  recovered: boolean;
};

/**
 * The circles of a flat face, read once for the `circle()` filter, the
 * face's properties and measure; see {@link FaceQuery.circlesOf}.
 */
export type FaceCircles = {
  /**
   * What makes the face a `circle()` face, and the circle that filter's
   * diameter is matched against: the face's outer boundary when that is one
   * full circle, whatever its holes (a disc, a washer, a disc with a square
   * hole). Null for any other flat face — but for one whose outer boundary
   * is circular arcs only: there the first hole that is not arcs alone
   * decides, and a full circle makes the face a circle of that hole's size.
   * That last rule is odd, and kept because it is what `circle()` has
   * always selected.
   */
  disc: FaceCircle | null;
  /**
   * The circle the outer boundary traces — one closed edge, or several arcs
   * sharing centre and radius (a revolve seam or a boolean splits a disc's
   * rim without changing what it bounds). Null when it traces anything else.
   */
  outer: FaceCircle | null;
};

const NO_CIRCLES: FaceCircles = { disc: null, outer: null };

// Relative part of the match between arcs of one outer circle; the absolute
// floor is 1 mm read in the active unit.
const CARRIER_FIT_TOL = 1e-6;

export class FaceQuery {
  // Wrapper methods (public API for external callers). The predicates name
  // a face: they read its class as SurfaceClassifier.classify gives it. A
  // feature that builds on a face asks through `forBuilding` and the
  // geometry readers below it instead.

  /** {@link isCircleFaceRaw}, answered from the wrapper's cached class. */
  static isCircleFace(face: Shape, diameter?: number): boolean {
    return FaceQuery.isCircleOf(FaceQuery.circlesOf(face).disc, diameter);
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

  /** The class a feature may build on; see {@link SurfaceClassifier.forBuilding}. */
  private static buildingClassOf(face: Shape): SurfaceClass {
    return SurfaceClassifier.forBuilding(face as Face);
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

  /** {@link isFaceOnPlaneRaw}, answered from the wrapper's cached class. */
  static isFaceOnPlane(face: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceQuery.isOnPlaneOf(FaceQuery.classOf(face), gpPln);
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
    return FaceQuery.sameSurface(FaceQuery.classOf(face1), FaceQuery.classOf(face2), SurfaceClassifier.tolerance());
  }

  /**
   * The questions above as a feature asks them before it builds on a face:
   * a face recovered from a B-spline counts as its plane, cylinder or cone
   * only when it matches within {@link SurfaceClassifier.buildingTolerance}
   * (see there for why naming and building differ). Whatever takes a
   * plane, an axis or a radius off a face to construct geometry asks here,
   * and then reads the geometry with the readers below, which hold to the
   * same rule.
   */
  static readonly forBuilding = {
    /** {@link FaceQuery.getSurfaceType} for building. */
    surfaceType: (face: Shape): string => FaceQuery.surfaceTypeOf(FaceQuery.buildingClassOf(face)),

    /** {@link FaceQuery.isPlanarFace} for building: a guard for `face.getPlane()` and {@link FaceQuery.getSurfacePlane}. */
    isPlanar: (face: Shape): boolean => FaceQuery.buildingClassOf(face).kind === 'plane',

    /** {@link FaceQuery.isSameSurface} for building, within the building tolerance once either face was recovered. */
    isSameSurface: (face1: Shape, face2: Shape): boolean => FaceQuery.sameSurface(
      FaceQuery.buildingClassOf(face1), FaceQuery.buildingClassOf(face2), SurfaceClassifier.buildingTolerance()),
  };

  // Geometry readers. Each hands a feature the plane, cylinder or cone to
  // build with, so each reads the face's building class (kept per wrapper:
  // a recovered face is recovered once, however many of these are asked)
  // and throws for a face that is not of that kind for building.

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

  /** `recoveredTolerance` is the distance bound once either class was recovered; native surfaces compare at 1e-7 mm. */
  private static sameSurface(a: SurfaceClass, b: SurfaceClass, recoveredTolerance: number): boolean {
    if (a.kind !== b.kind || !SurfaceClassifier.isAnalytic(a.kind)) {
      return false;
    }
    // Distances (plane offset, radius, apex, axis offset): 1e-7 mm in the
    // active unit between native surfaces, the recovery tolerance once
    // either was recovered. The angular bounds are unit-free.
    const recovered = a.recovered || b.recovered;
    const tolerance = recovered ? recoveredTolerance : mmTol(1e-7);
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

  /** The face's plane for OCCT, native or recovered; the caller deletes it. Throws for a face that is no plane to build on. */
  static gpPlaneOf(face: Shape): gp_Pln {
    return SurfaceClassifier.gpPlane(FaceQuery.buildingClassOf(face));
  }

  /** The face's cylinder for OCCT, native or recovered; the caller deletes it. Throws for a face that is no cylinder to build on. */
  static gpCylinderOf(face: Shape): gp_Cylinder {
    return SurfaceClassifier.gpCylinder(FaceQuery.buildingClassOf(face));
  }

  /** The face's cone for OCCT, native or recovered; the caller deletes it. Throws for a face that is no cone to build on. */
  static gpConeOf(face: Shape): gp_Cone {
    return SurfaceClassifier.gpCone(FaceQuery.buildingClassOf(face));
  }

  /**
   * The V-bounds of `face` on its surface. For a cylindrical surface V is
   * the axial coordinate; for a conical surface V is along the slant
   * (caller multiplies by `cos(semiAngle)` to get axial Z). A cylinder or
   * cone recovered from a B-spline has no parameters of its own on the
   * recovered surface, so its bounds are the face's exact extent along the
   * recovered axis.
   */
  static getSurfaceVBounds(face: Shape): { vMin: number; vMax: number } {
    const surface = FaceQuery.buildingClassOf(face);
    if (surface.recovered && surface.axis && (surface.kind === 'cylinder' || surface.kind === 'cone')) {
      const slant = surface.kind === 'cone' ? Math.cos(surface.semiAngle ?? 0) : 1;
      const across = Plane.fromPointAndNormal(surface.axis.origin, surface.axis.direction);
      const extent = ShapeOps.extentAlongRaw(face.getShape(), across);
      return { vMin: extent.min / slant, vMax: extent.max / slant };
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

  // Raw methods (for oc-internal and common/ use). Each classifies the face
  // afresh through SurfaceClassifier; the wrapper forms above read the class
  // kept per wrapper.

  /**
   * A flat, disc-shaped face: planar (see {@link SurfaceClassifier}) with a
   * full circle for its outer boundary (see {@link FaceCircles.disc}), of
   * the given diameter when one is asked for.
   */
  static isCircleFaceRaw(face: TopoDS_Shape, diameter?: number): boolean {
    return FaceQuery.isCircleOf(FaceQuery.circlesOfRaw(face, SurfaceClassifier.classifyRaw(face)).disc, diameter);
  }

  /** A disc of the given diameter, if one is asked for: to OCCT's own precision for a native circle, to the recovery tolerance for one recovered from a B-spline. */
  private static isCircleOf(disc: FaceCircle | null, diameter?: number): boolean {
    if (!disc) {
      return false;
    }
    if (diameter === undefined) {
      return true;
    }
    const tolerance = disc.recovered ? CurveClassifier.tolerance() : getOC().Precision.Confusion();
    return Math.abs(disc.radius - diameter / 2) <= tolerance;
  }

  /**
   * The circles of a flat face (see {@link FaceCircles}), read off the
   * wrapper's wires and their edges' cached classes, and kept with the
   * face's class. The one reading the `circle()` filter, the face's
   * properties and measure share, so they name the same circle.
   */
  static circlesOf(face: Shape): FaceCircles {
    return SurfaceClassifier.derived(face as Face, 'circles', () => {
      if (FaceQuery.classOf(face).kind !== 'plane') {
        return NO_CIRCLES;
      }
      const typed = face as Face;
      const outer = typed.getOuterWire();
      const classes = (wire: Wire) => wire.getEdges().map(edge => CurveClassifier.classify(edge));
      return FaceQuery.circlesFrom(outer ? classes(outer) : [], typed.getHoleWires().map(classes));
    });
  }

  /** {@link circlesOf} for a raw face of class `surface`, asked of OCCT every time. */
  static circlesOfRaw(face: TopoDS_Shape, surface: SurfaceClass): FaceCircles {
    if (surface.kind !== 'plane') {
      return NO_CIRCLES;
    }
    const oc = getOC();
    const typed = oc.TopoDS.Face(face);
    const outerWire = oc.BRepTools.OuterWire(typed);
    try {
      // The explorer copies are this read's own.
      const classes = (wire: TopoDS_Shape) => Explorer.withShapes(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges =>
        edges.map(edge => CurveClassifier.classifyRaw(edge)));
      return Explorer.withShapes(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum, wires => FaceQuery.circlesFrom(
        outerWire.IsNull() ? [] : classes(outerWire),
        wires.filter(wire => !wire.IsSame(outerWire)).map(classes),
      ));
    } finally {
      outerWire.delete();
      typed.delete();
    }
  }

  /** The circles of a flat face given its loops' edges, the outer loop apart from the holes (in stored order). */
  private static circlesFrom(outer: CurveClass[], holes: CurveClass[][]): FaceCircles {
    return { disc: FaceQuery.firstFullCircle([outer, ...holes]), outer: FaceQuery.oneCircle(outer) };
  }

  /**
   * The first full circle met walking the loops in order, every edge before
   * it an arc; null once any other edge is met first, or none is found.
   */
  private static firstFullCircle(loops: CurveClass[][]): FaceCircle | null {
    for (const curve of loops.flat()) {
      if (curve.kind === 'circle') {
        return FaceQuery.circleOf(curve);
      }
      if (curve.kind !== 'arc') {
        return null;
      }
    }
    return null;
  }

  /** The circle a loop traces: one closed edge, or arcs sharing centre and radius. */
  private static oneCircle(loop: CurveClass[]): FaceCircle | null {
    let found: FaceCircle | null = null;
    for (const curve of loop) {
      const rim = FaceQuery.circleOf(curve);
      if (!rim) {
        return null;
      }
      if (!found) {
        found = rim;
        continue;
      }
      const tolerance = CARRIER_FIT_TOL * (mmTol(1) + rim.radius);
      if (rim.center.distanceTo(found.center) > tolerance || Math.abs(rim.radius - found.radius) > tolerance) {
        return null;
      }
      found = { ...found, recovered: found.recovered || rim.recovered };
    }
    return found;
  }

  private static circleOf(curve: CurveClass): FaceCircle | null {
    if ((curve.kind !== 'circle' && curve.kind !== 'arc') || !curve.center || curve.radius === undefined) {
      return null;
    }
    return { center: curve.center, radius: curve.radius, recovered: curve.recovered };
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

  /** A sphere of the given diameter, if one is asked for, its radius matched as {@link isCylinderOf} matches a cylinder's. */
  private static isSphereOf(surface: SurfaceClass, diameter?: number): boolean {
    if (surface.kind !== 'sphere' || surface.radius === undefined) {
      return false;
    }
    return diameter === undefined || Math.abs(surface.radius - diameter / 2) <= FaceQuery.sizeTolerance(surface);
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

  /** A planar face (native or recovered) lying on `plane`: parallel to it, a point of it on the plane. */
  static isFaceOnPlaneRaw(face: TopoDS_Shape, plane: gp_Pln): boolean {
    return FaceQuery.isOnPlaneOf(SurfaceClassifier.classifyRaw(face), plane);
  }

  /**
   * A plane class lying on `plane`: its origin on the plane, its normal
   * along the plane's (either way round, by the dot of the two as this
   * test has always been made). A native plane's origin is held to OCCT's
   * confusion tolerance; a recovered one may sit as far off as recovery let
   * it stray from the face.
   */
  private static isOnPlaneOf(surface: SurfaceClass, plane: gp_Pln): boolean {
    if (surface.kind !== 'plane' || !surface.origin || !surface.normal) {
      return false;
    }
    const oc = getOC();
    const [origin, dispose] = Convert.toGpPnt(surface.origin);
    const axis = plane.Axis();
    const normal = axis.Direction();
    try {
      if (plane.Distance(origin) > FaceQuery.sizeTolerance(surface)) {
        return false;
      }
      const dot = normal.X() * surface.normal.x + normal.Y() * surface.normal.y + normal.Z() * surface.normal.z;
      return Math.abs(Math.abs(dot) - 1.0) < oc.Precision.Angular();
    } finally {
      normal.delete();
      axis.delete();
      dispose();
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
