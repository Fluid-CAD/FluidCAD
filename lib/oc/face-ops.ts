import type { gp_Cone, gp_Cylinder, gp_Pln, TopoDS_Edge, TopoDS_Face, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { mmTol } from "../units/tolerance.js";
import { SurfaceClass, SurfaceClassifier } from "./surface-classifier.js";

export class FaceOps {
  /**
   * The plane of a flat face, to build on: a native plane's, or the one
   * {@link SurfaceClassifier} recovers from a flat B-spline within its
   * building tolerance. Throws for any other face, saying so when the face
   * is flat enough to be named planar but not to be built on.
   */
  static getPlane(face: Face | TopoDS_Face): Plane {
    const named = FaceOps.classOf(face);
    const plane = FaceOps.planeOf(SurfaceClassifier.buildingOf(named), FaceOps.rawOf(face));
    if (!plane) {
      throw new Error((named.kind === 'plane' ? SurfaceClassifier.buildingRefusal(named) : null) ?? "Face is not planar");
    }
    return plane;
  }

  /** The face's plane as {@link getPlane} reads it, or null when the face is no plane to build on. Never throws. */
  static tryGetPlane(face: Face | TopoDS_Face): Plane | null {
    return FaceOps.planeOf(SurfaceClassifier.buildingOf(FaceOps.classOf(face)), FaceOps.rawOf(face));
  }

  private static rawOf(face: Face | TopoDS_Face): TopoDS_Face {
    return face instanceof Face ? face.getShape() : face;
  }

  /** A wrapper's class is kept with it; a raw face is classified afresh. */
  private static classOf(face: Face | TopoDS_Face): SurfaceClass {
    return face instanceof Face ? SurfaceClassifier.classify(face) : SurfaceClassifier.classifyRaw(face);
  }

  /** The plane a `plane` class describes, facing out of `face`; null for any other class. */
  private static planeOf(surface: SurfaceClass, face: TopoDS_Face): Plane | null {
    if (surface.kind !== 'plane' || !surface.origin || !surface.normal) {
      return null;
    }
    // The surface's own axis carries whatever sign it was built with, and a
    // reversed face flips it: the outward normal gives the side.
    const outward = FaceOps.outwardNormalRaw(face);
    const normal = outward && outward.dot(surface.normal) < 0 ? surface.normal.negate() : surface.normal;
    // Canonical origin: the foot of the perpendicular from the world origin,
    // so identical planes compare equal.
    const origin = normal.multiply(surface.origin.toVector3d().dot(normal));

    // The in-plane axes come from the normal, never from the surface's own
    // ax3 X direction: that is whatever the modelling operation happened to
    // store, and it is *not* flipped when the face is REVERSED — so a prism's
    // start cap came out rotated 180° from the sketch plane that made it,
    // and a sketch on it rendered upside down.
    return Plane.upright(new Point(origin.x, origin.y, origin.z), normal);
  }

  static calculateNormal(face: Face | TopoDS_Face): Vector3d {
    const rawFace = face instanceof Face ? face.getShape() as TopoDS_Face : face;
    return FaceOps.calculateNormalRaw(rawFace);
  }

  /**
   * The face's outer (boundary) wire; every other wire of the face bounds a
   * hole. Pure topology — no tolerance, no geometry — so it holds under
   * fillets, booleans and shells alike. The caller owns the returned wire.
   */
  static outerWireRaw(face: TopoDS_Face): TopoDS_Wire {
    const oc = getOC();
    return oc.BRepTools.OuterWire(oc.TopoDS.Face(face));
  }

  /**
   * The axis of a face whose surface is a cylinder or a cone to build on
   * (native, or recovered within {@link SurfaceClassifier.buildingTolerance})
   * — origin at the surface's own location, direction along its axis — or
   * null for any other surface. The direction carries the surface's raw
   * sign: for an extruded circle that is the extrude direction, for a
   * revolve or an imported body whatever the modeller stored. Callers that
   * need a stable sign apply {@link Vector3d.canonicalSign}.
   */
  static axialSurfaceAxis(face: Face | TopoDS_Face): Axis | null {
    const surface = SurfaceClassifier.buildingOf(FaceOps.classOf(face));
    return surface.kind === 'cylinder' || surface.kind === 'cone' ? surface.axis ?? null : null;
  }

  /**
   * The face's outward normal at its surface's parameter origin, (u, v) =
   * (0, 0): exact anywhere on a planar face, only a probe on a curved one
   * (see {@link outwardNormalRaw}, which also takes a parameter). Throws
   * where the normal is undefined there.
   */
  static calculateNormalRaw(face: TopoDS_Face): Vector3d {
    const normal = FaceOps.outwardNormalRaw(face, { u: 0, v: 0 });
    if (!normal) {
      throw new Error("The face normal is undefined at its surface's parameter origin");
    }
    return normal;
  }

  /**
   * The face's OUTWARD (material-out) unit normal at surface parameters
   * `uv`, by default the centre of the face's UV bounds
   * ({@link uvCentreRaw}). It is the surface's parametric normal (D1U × D1V
   * — not a plane's axis, which a left-handed frame reverses), reversed
   * when the face is TopAbs_REVERSED. That flag is
   * the face's orientation in its solid, so the face must carry it: take it
   * from the solid through an Explorer (TopExp_Explorer composes it) or a
   * list built that way, such as `Solid.getIndexedShapes('face')`. Without
   * it the normal points into the material on about half the faces of a
   * box. A located face (an assembly pose applied with `Moved`) is evaluated
   * where it sits. Null where the normal is undefined (a degenerate apex).
   */
  static outwardNormalRaw(face: TopoDS_Face, uv?: { u: number; v: number }): Vector3d | null {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face);
    const at = uv ?? FaceOps.uvCentreRaw(rawFace);
    const surface = oc.BRep_Tool.Surface(rawFace);
    const props = new oc.GeomLProp_SLProps(surface, at.u, at.v, 1, 1e-6);
    try {
      if (!props.IsNormalDefined()) {
        return null;
      }
      const normal = props.Normal();
      try {
        const vector = Convert.toVector3dFromGpDir(normal);
        return rawFace.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? vector.negate() : vector;
      } finally {
        normal.delete();
      }
    } finally {
      props.delete();
      surface.delete();
      rawFace.delete();
    }
  }

  /**
   * The direction the face faces as a whole: the mean of its outward unit
   * normals, each weighted by the area around it, as a unit vector — or
   * null when the face faces nowhere, its normals cancelling to a mean
   * shorter than {@link FACES_NOWHERE_BELOW}. A flat face faces along its
   * normal, a half cylinder its middle, a dome its pole; a bore, a boss
   * wall and a whole sphere face nowhere. One point cannot say this for a
   * face that wraps: the middle of its parameters is only the meridian
   * opposite wherever the kernel put the seam.
   *
   * The mean is read on a grid over the face's UV bounds, whatever part of
   * them the face's boundary trims away. Like {@link outwardNormalRaw}, it
   * needs the face's orientation in its body.
   */
  static meanOutwardNormalRaw(face: TopoDS_Face): Vector3d | null {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(rawFace, true);
    const point = new oc.gp_Pnt();
    const alongU = new oc.gp_Vec();
    const alongV = new oc.gp_Vec();
    try {
      if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        // One normal everywhere: read it once, exactly.
        return FaceOps.outwardNormalRaw(rawFace);
      }
      const uMin = adaptor.FirstUParameter();
      const vMin = adaptor.FirstVParameter();
      const uStep = (adaptor.LastUParameter() - uMin) / FaceOps.MEAN_NORMAL_GRID;
      const vStep = (adaptor.LastVParameter() - vMin) / FaceOps.MEAN_NORMAL_GRID;
      if (!Number.isFinite(uStep) || !Number.isFinite(vStep)) {
        return null;
      }
      // dS/du × dS/dv is the normal scaled by the area its cell covers, so
      // the sum over the cells is the area-weighted sum of unit normals, and
      // a degenerate point (a pole, an apex) adds nothing to it.
      let sum = new Vector3d(0, 0, 0);
      let area = 0;
      for (let i = 0; i < FaceOps.MEAN_NORMAL_GRID; i++) {
        for (let j = 0; j < FaceOps.MEAN_NORMAL_GRID; j++) {
          adaptor.D1(uMin + (i + 0.5) * uStep, vMin + (j + 0.5) * vStep, point, alongU, alongV);
          const scaled = new Vector3d(alongU.X(), alongU.Y(), alongU.Z())
            .cross(new Vector3d(alongV.X(), alongV.Y(), alongV.Z()));
          sum = sum.add(scaled);
          area += scaled.length();
        }
      }
      if (!(area > 0) || sum.length() < FaceOps.FACES_NOWHERE_BELOW * area) {
        return null;
      }
      const mean = sum.normalize();
      return rawFace.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? mean.negate() : mean;
    } finally {
      alongV.delete();
      alongU.delete();
      point.delete();
      adaptor.delete();
      rawFace.delete();
    }
  }

  /**
   * How long the mean of a face's unit normals must be for the face to
   * face anywhere — unit: dimensionless. A flat face's is 1, a half
   * cylinder's 0.64, a hemisphere's 0.5; a cylinder open by a 20° slit
   * comes to 0.06 and a full wall with 5° of draft to 0.09, and neither
   * faces a way a person would name.
   */
  static readonly FACES_NOWHERE_BELOW = 0.1;

  /**
   * Cells each way in the grid {@link meanOutwardNormalRaw} reads, at their
   * middles. Eight equal steps cancel exactly round a full turn, as any
   * even count does, and the cell middles stay off the seam, the poles and
   * an apex; on a half cylinder they put the mean's length within 1% and
   * its direction on the bisector. 64 evaluations cost about a tenth of a
   * millisecond per face, once.
   */
  private static readonly MEAN_NORMAL_GRID = 8;

  /**
   * The centre of the face's UV bounds, where {@link outwardNormalRaw}
   * probes by default. A caller that pairs that normal with the surface
   * point passes this to both, so they come from one parameter.
   */
  static uvCentreRaw(face: TopoDS_Face): { u: number; v: number } {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face);
    try {
      const bounds = oc.BRepTools.UVBounds(rawFace);
      return { u: (bounds.UMin + bounds.UMax) / 2, v: (bounds.VMin + bounds.VMax) / 2 };
    } finally {
      rawFace.delete();
    }
  }

  /** The face's surface point at parameters `uv`, where the face sits (its location applied). */
  static pointAtRaw(face: TopoDS_Face, uv: { u: number; v: number }): Point {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face);
    const adaptor = new oc.BRepAdaptor_Surface(rawFace, false);
    try {
      return Convert.toPoint(adaptor.Value(uv.u, uv.v), true);
    } finally {
      adaptor.delete();
      rawFace.delete();
    }
  }

  /**
   * The face's OUTWARD normal where `edge` runs along it — evaluated at the
   * mid-parameter by default (or at `fraction` along the pcurve), so it is exact on curved
   * faces (a cylinder's normal rotates along the rim; the UV-mid probe would
   * be off by the angular distance). Oriented outward by
   * {@link outwardNormalRaw}.
   *
   * The pcurve comes from the face-form `BRep_Tool::CurveOnSurface` (bound
   * as `BRep_ToolExt.CurveOnFace`), which also derives one on the fly for
   * faces that store none — planar faces, typically. Null when the edge has
   * no pcurve on this face or the normal is undefined there (a degenerate
   * apex).
   */
  static outwardNormalOnEdge(face: Face | TopoDS_Face, edge: Edge | TopoDS_Edge, fraction = 0.5): Vector3d | null {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face instanceof Face ? face.getShape() : face);
    const rawEdge = oc.TopoDS.Edge(edge instanceof Edge ? edge.getShape() : edge);

    const rep = oc.BRep_ToolExt.CurveOnFace(rawEdge, rawFace);
    const pcurve = rep.returnValue;
    // A null handle arrives as JS null, never as a wrapper.
    if (!pcurve) {
      rep[Symbol.dispose]?.();
      rawEdge.delete(); rawFace.delete();
      return null;
    }
    const uv = pcurve.Value(rep.First + (rep.Last - rep.First) * fraction);
    try {
      return FaceOps.outwardNormalRaw(rawFace, { u: uv.X(), v: uv.Y() });
    } finally {
      uv.delete();
      pcurve.delete();
      rep[Symbol.dispose]?.();
      rawEdge.delete(); rawFace.delete();
    }
  }

  static makeFace(wire: TopoDS_Wire): TopoDS_Face {
    const oc = getOC();
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

    const MakeFaceFn = new oc.BRepBuilderAPI_MakeFace(wires[0], true);

    try {
      for (let i = 1; i < wires.length; i++) {
        MakeFaceFn.Add(wires[i]);
      }

      if (MakeFaceFn.IsDone()) {
        return MakeFaceFn.Face();
      } else {
        throw new Error("Failed to create face from wires: " + MakeFaceFn.Error());
      }
    } finally {
      // The face is a copy of its own; the maker goes.
      MakeFaceFn.delete();
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
    try {
      for (const hole of holes) {
        faceMaker.Add(hole.getShape() as TopoDS_Wire);
      }
      return Face.fromTopoDSFace(faceMaker.Face());
    } finally {
      faceMaker.delete();
    }
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
    // A 100 mm visual half-size, in the document's unit.
    const size = mmTol(100);

    if (center) {
      const translation = center.subtract(plane.origin);
      plane = plane.translate(translation.x, translation.y, translation.z);
    }

    return Face.fromTopoDSFace(FaceOps.makeSquareFace(plane, size));
  }

  /** A square planar face centred on the plane's origin, `halfSize` to each side. */
  static makeSquareFace(plane: Plane, halfSize: number): TopoDS_Face {
    const oc = getOC();
    const [pln, dispose] = Convert.toGpPln(plane);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(pln, -halfSize, halfSize, -halfSize, halfSize);
    const face = faceMaker.Face();
    faceMaker.delete();
    dispose();
    return face;
  }
}
