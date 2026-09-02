import type { gp_Cone, gp_Cylinder, gp_Pln, TopoDS_Face, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { mmTol } from "../units/tolerance.js";

export class FaceOps {
  static getPlane(face: Face | TopoDS_Face): Plane {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    return FaceOps.getPlaneRaw(rawFace);
  }

  static getPlaneRaw(face: TopoDS_Face): Plane {
    console.log("Extracting plane from face...");
    const plane = FaceOps.tryGetPlaneRaw(face);
    if (!plane) {
      throw new Error("Face is not planar");
    }
    return plane;
  }

  /** The face's plane, or null when the face is not planar. Never throws. */
  static tryGetPlane(face: Face | TopoDS_Face): Plane | null {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    return FaceOps.tryGetPlaneRaw(rawFace);
  }

  static tryGetPlaneRaw(face: TopoDS_Face): Plane | null {
    const oc = getOC();
    const topoFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(topoFace, true);

    const type = adaptor.GetType();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      adaptor.delete();
      // OCC stores geometrically-flat walls produced by loft/sweep (and some
      // imported STEP faces) as B-spline surfaces, so the adaptor type is not
      // GeomAbs_Plane even though the face lies on a plane. Fall back to
      // fitting a plane and verifying the surface really is flat.
      return FaceOps.tryFitPlaneRaw(face);
    }

    let pln = adaptor.Plane();

    const ax3 = pln.Position();
    const direction = ax3.Direction();
    const location = ax3.Location();

    const normal = FaceOps.calculateNormalRaw(face);

    let loc: Vector3d = new Vector3d(location.X(), location.Y(), location.Z());

    const dot = loc.dot(normal);
    const origin = normal.multiply(dot);

    pln.delete();
    adaptor.delete();
    ax3.delete();
    direction.delete();
    location.delete();

    // The in-plane axes come from the normal, never from the surface's own
    // ax3 X direction: that is whatever the modelling operation happened to
    // store, and it is *not* flipped when the face is REVERSED — so a prism's
    // start cap came out rotated 180° from the sketch plane that made it,
    // and a sketch on it rendered upside down.
    return Plane.upright(new Point(origin.x, origin.y, origin.z), normal);
  }

  /**
   * Recovers the plane of a face whose parametric surface is not
   * `GeomAbs_Plane` but is geometrically flat (e.g. a loft or sweep side wall,
   * which OCC stores as a B-spline). Returns null when no plane fits the
   * boundary edges, or when the surface interior deviates from that plane — so
   * a domed face with a planar rim is correctly rejected.
   */
  private static tryFitPlaneRaw(face: TopoDS_Face): Plane | null {
    const oc = getOC();
    // Use the face's own modelling tolerance (never tighter than the kernel's
    // confusion tolerance) both to fit the plane and to judge flatness, so a
    // face built at a looser tolerance is not falsely rejected.
    const tolerance = Math.max(oc.BRep_Tool.Tolerance(oc.TopoDS.Face(face)), oc.Precision.Confusion());

    const finder = new oc.BRepBuilderAPI_FindPlane(face, tolerance);
    if (!finder.Found()) {
      finder.delete();
      return null;
    }

    const geomPlane = finder.Plane();
    const pln = geomPlane.Pln();
    const location = pln.Location();

    const loc = new Vector3d(location.X(), location.Y(), location.Z());

    location.delete();
    pln.delete();
    geomPlane.delete();
    finder.delete();

    // FindPlane only fits the boundary edges; confirm the surface interior lies
    // on that plane before trusting it as flat.
    const normal = FaceOps.calculateNormalRaw(face);
    if (!FaceOps.surfaceLiesOnPlane(face, loc, normal, tolerance)) {
      return null;
    }

    // Canonical origin: foot of the perpendicular from the world origin onto
    // the plane, matching the GeomAbs_Plane path so identical planes compare equal.
    // FindPlane only fits a least-squares X direction, so — as in that path —
    // the in-plane axes are derived from the normal instead.
    const origin = normal.multiply(loc.dot(normal));
    return Plane.upright(new Point(origin.x, origin.y, origin.z), normal);
  }

  /**
   * True when every sampled point of the face's surface lies within `tolerance`
   * of the plane through `pointOnPlane` with the given `normal`. Samples a UV
   * grid over the face's trimmed parameter range.
   */
  private static surfaceLiesOnPlane(
    face: TopoDS_Face,
    pointOnPlane: Vector3d,
    normal: Vector3d,
    tolerance: number,
  ): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
    const u0 = adaptor.FirstUParameter();
    const u1 = adaptor.LastUParameter();
    const v0 = adaptor.FirstVParameter();
    const v1 = adaptor.LastVParameter();

    const steps = 3;
    let flat = true;
    for (let i = 0; i <= steps && flat; i++) {
      for (let j = 0; j <= steps && flat; j++) {
        const u = u0 + ((u1 - u0) * i) / steps;
        const v = v0 + ((v1 - v0) * j) / steps;
        const p = adaptor.Value(u, v);
        const dist = Math.abs(
          normal.x * (p.X() - pointOnPlane.x) +
          normal.y * (p.Y() - pointOnPlane.y) +
          normal.z * (p.Z() - pointOnPlane.z),
        );
        p.delete();
        if (dist > tolerance) {
          flat = false;
        }
      }
    }

    adaptor.delete();
    return flat;
  }

  static calculateNormal(face: Face | TopoDS_Face): Vector3d {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    return FaceOps.calculateNormalRaw(rawFace);
  }

  static calculateNormalRaw(face: TopoDS_Face): Vector3d {
    const oc = getOC();

    const surface = oc.BRep_Tool.Surface(oc.TopoDS.Face(face));
    const props = new oc.GeomLProp_SLProps(surface, 0, 0, 1, 1e-6);
    let normal = props.Normal();

    if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
      normal = normal.Reversed();
    }

    const result = Convert.toVector3dFromGpDir(normal);

    surface.delete();
    props.delete();
    normal.delete();

    return result;
  }

  static faceOnPlane(face: TopoDS_Face, plane: gp_Pln): boolean {
    const oc = getOC();

    const faceAdaptor = new oc.BRepAdaptor_Surface(face, true);
    const type = faceAdaptor.GetType();

    if (type !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      return false;
    }

    const facePlane = faceAdaptor.Plane();
    const location = facePlane.Location();

    if (!plane.Contains(location, oc.Precision.Confusion())) {
      faceAdaptor.delete();
      location.delete();
      return false;
    }

    const axis1 = plane.Axis().Direction();
    const axis2 = facePlane.Axis().Direction();

    const dot = axis1.Dot(axis2);

    faceAdaptor.delete();
    location.delete();

    return Math.abs(Math.abs(dot) - 1.0) < oc.Precision.Angular();
  }

  static faceOnPlaneWrapped(face: Face, plane: Plane): boolean {
    const oc = getOC();
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = FaceOps.faceOnPlane(face.getShape() as TopoDS_Face, gpPln);
    dispose();
    return result;
  }

  static makeFace(wire: TopoDS_Wire): TopoDS_Face {
    const oc = getOC();
    console.log("Creating face from wire:", wire);
    const MakeFaceFn = new oc.BRepBuilderAPI_MakeFace(wire, false);

    if (MakeFaceFn.IsDone()) {
      const face = MakeFaceFn.Face();
      MakeFaceFn.delete();
      return face;
    } else {
      const err = MakeFaceFn.Error();
      throw new Error("Failed to create face: ", err);
    }
  }

  static makeFaceWrapped(wire: Wire): Face {
    const rawFace = FaceOps.makeFace(wire.getShape() as TopoDS_Wire);
    return Face.fromTopoDSFace(rawFace);
  }

  static makeFaceOnPlane(wire: TopoDS_Wire, plane: gp_Pln): TopoDS_Face {
    const oc = getOC();
    const MakeFaceFn = new oc.BRepBuilderAPI_MakeFace(plane);
    MakeFaceFn.Add(wire);

    if (MakeFaceFn.IsDone()) {
      const face = MakeFaceFn.Face();
      MakeFaceFn.delete();
      return face;
    } else {
      const err = MakeFaceFn.Error();
      throw new Error("Failed to create face: ", err);
    }
  }

  static makeFaceOnPlaneWrapped(wire: Wire, plane: Plane): Face {
    const oc = getOC();
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const rawFace = FaceOps.makeFaceOnPlane(oc.TopoDS.Wire(wire.getShape()), gpPln);
    dispose();
    return Face.fromTopoDSFace(rawFace);
  }

  static planeFromFace(face: Face | TopoDS_Face, calculateNormalFn: () => Vector3d): Plane {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    const oc = getOC();

    const topoFace = oc.TopoDS.Face(rawFace);
    const surfaceAdaptor = new oc.BRepAdaptor_Surface(topoFace, true);

    if (surfaceAdaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      console.log("Face is a plane, extracting axis");
      const plane = surfaceAdaptor.Plane();

      surfaceAdaptor.delete();

      const normal = calculateNormalFn();

      const xAxis = plane.XAxis();
      const zAxis = plane.Axis();

      const planeOrigin = plane.Location();
      const xDir = xAxis.Direction();

      const projectedOrigin = Plane.projectPoint(
        Point.origin(),
        Convert.toPoint(planeOrigin),
        normal,
      );

      const pln = new Plane(
        projectedOrigin,
        Convert.toVector3dFromGpDir(xDir),
        normal,
      );

      xDir.delete();
      planeOrigin.delete();
      xAxis.delete();
      zAxis.delete();
      plane.delete();

      return pln;
    }

    surfaceAdaptor.delete();
    throw new Error("Face does not represent a planar face");
  }

  static makeFaceFromWires(wires: TopoDS_Wire[]): TopoDS_Face {
    const oc = getOC();

    if (wires.length === 0) {
      throw new Error("No wires provided to create a face.");
    }

    console.log("Creating face from wires:");
    const MakeFaceFn = new oc.BRepBuilderAPI_MakeFace(wires[0], true);
    console.log("Number of wires:", wires.length);

    for (let i = 1; i < wires.length; i++) {
      console.log("Adding wire:", wires[i]);
      MakeFaceFn.Add(wires[i]);
    }

    if (MakeFaceFn.IsDone()) {
      return MakeFaceFn.Face();
    } else {
      throw new Error("Failed to create face from wires: " + MakeFaceFn.Error());
    }
  }

  static fixFaceOrientation(face: Face | TopoDS_Face): Face {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    const oc = getOC();
    const fixer = new oc.ShapeFix_Face(rawFace);
    fixer.FixOrientation();
    fixer.Perform();
    const fixedFace = fixer.Face();
    fixer.delete();
    return Face.fromTopoDSFace(fixedFace);
  }

  static makeFaceWithHoles(outerWire: Wire, holes: Wire[]): Face {
    const oc = getOC();
    const faceMaker = new oc.BRepLib_MakeFace(outerWire.getShape() as TopoDS_Wire, false);
    for (const hole of holes) {
      faceMaker.Add(hole.getShape() as TopoDS_Wire);
    }
    return Face.fromTopoDSFace(faceMaker.Face());
  }

  static isPointInsideFace(point: Point, face: Face | TopoDS_Face): boolean {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    const oc = getOC();
    const [gpPnt, disposePnt] = Convert.toGpPnt(point);
    const classifier = new oc.BRepClass_FaceClassifier();
    classifier.Perform(rawFace, gpPnt, oc.Precision.Confusion(), true, oc.Precision.Confusion());
    const state = classifier.State();
    const isInside = state === oc.TopAbs_State.TopAbs_IN;
    classifier.delete();
    disposePnt();
    return isInside;
  }

  static makeFaceFromPlane2(
    plane: gp_Pln,
    bounds?: { uMin: number; uMax: number; vMin: number; vMax: number },
  ): TopoDS_Face {
    const oc = getOC();
    const b = bounds ?? { uMin: -1000, uMax: 1000, vMin: -1000, vMax: 1000 };
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(plane, b.uMin, b.uMax, b.vMin, b.vMax);
    const face = faceMaker.Face();
    faceMaker.delete();
    return face;
  }

  static makeFaceFromPlane(plane: gp_Pln): TopoDS_Face {
    const oc = getOC();
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(plane);
    const face = faceMaker.Face();
    faceMaker.delete();
    return face;
  }

  static makeFaceFromCylinder(cylinder: gp_Cylinder): TopoDS_Face {
    const oc = getOC();
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(cylinder);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      throw new Error("Failed to create face from cylinder");
    }
    const face = faceMaker.Face();
    faceMaker.delete();
    return face;
  }

  static makeFaceFromCone(cone: gp_Cone): TopoDS_Face {
    const oc = getOC();
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(cone);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      throw new Error("Failed to create face from cone");
    }
    const face = faceMaker.Face();
    faceMaker.delete();
    return face;
  }

  static planeToFace(plane: Plane, center?: Point): Face {
    const oc = getOC();

    // A 100 mm visual half-size, in the document's unit.
    const size = mmTol(100);

    if (center) {
      const translation = center.subtract(plane.origin);
      plane = plane.translate(translation.x, translation.y, translation.z);
    }

    const [pln, dispose] = Convert.toGpPln(plane);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln, -size, size, -size, size);
    const face = faceMaker.Face();
    faceMaker.delete();
    dispose();

    return Face.fromTopoDSFace(face);
  }
}
