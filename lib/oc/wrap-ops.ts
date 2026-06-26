import type {
  Geom2d_BSplineCurve, Geom_Surface,
  BRepAdaptor_Curve, TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Wire,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Explorer } from "./explorer.js";
import { FaceQuery } from "./face-query.js";
import { WireOps } from "./wire-ops.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import {
  ConeDevelopment, CylinderDevelopment, Development, UV,
} from "./wrap-development.js";
import { interpolateBSpline2d } from "../math/bspline-interpolation.js";

/** Sample points per curved sketch edge before fitting its UV pcurve. */
const CURVED_EDGE_SAMPLES = 48;
/** Margin (radians) kept free so a wrapped region never closes on itself. */
const FULL_TURN_MARGIN = 1e-3;
/** Walls are ruled along the surface normal, so their normals are (near) perpendicular to it. */
const ALIGNED_NORMAL_THRESHOLD = 0.7;

export interface WrapResult {
  solids: Shape[];
  /** Faces lying on the target surface (the base of the wrap). */
  startFaces: Face[];
  /** Faces offset from the target surface by the wrap thickness. */
  endFaces: Face[];
  /** Wall faces generated from the outer boundary of each region. */
  sideFaces: Face[];
  /** Wall faces generated from sketch holes inside a region. */
  internalFaces: Face[];
}

/** Tracks the u-range covered by a wrapped region to reject over-full wraps. */
class UvSpan {
  private min = Infinity;
  private max = -Infinity;

  add(u: number): void {
    if (u < this.min) {
      this.min = u;
    }
    if (u > this.max) {
      this.max = u;
    }
  }

  assertWithinOneTurn(): void {
    if (this.max - this.min > 2 * Math.PI - FULL_TURN_MARGIN) {
      throw new Error("wrap(): the sketch is too wide for the target surface — it would wrap around more than a full turn");
    }
  }
}

export class WrapOps {
  /**
   * Wraps planar sketch region faces onto the surface of `targetFace` and
   * thickens them by `thickness` measured along the surface normal. Positive
   * thickness grows out of the material (emboss), negative grows into it
   * (deboss tool). Returns the thickened solids with their faces classified.
   *
   * The pad base lies EXACTLY on the target surface. Downstream booleans
   * resolve that coincident-face contact via their fuzzy tolerance and
   * same-domain handling; do not be tempted to sink the base slightly past
   * the surface to "help" them — the resulting wall∕target section curves
   * are approximated by OCCT and oscillate visibly near the wall joints.
   */
  static wrap(regionFaces: Face[], sketchPlane: Plane, targetFace: Face, thickness: number): WrapResult {
    const development = WrapOps.createDevelopment(targetFace, sketchPlane);
    const surface = WrapOps.makeSurface(development);

    // Positive thickness must grow out of the material. The rebuilt
    // development surface always thickens toward the development's outward
    // normal (away from the axis), so flip the offset when the target face's
    // material normal points toward the axis (e.g. a bore wall).
    const signedOffset = WrapOps.isInwardFacing(targetFace, development)
      ? -thickness
      : thickness;

    const result: WrapResult = {
      solids: [],
      startFaces: [],
      endFaces: [],
      sideFaces: [],
      internalFaces: [],
    };

    try {
      for (const region of regionFaces) {
        const wrappedFace = WrapOps.wrapRegion(region, sketchPlane, development, surface);
        const thickened = WrapOps.thicken(wrappedFace, signedOffset);
        WrapOps.classify(thickened, wrappedFace, development, result);
      }
    } finally {
      surface.delete();
    }

    return result;
  }

  /** Builds the development mapping for the target face's underlying surface. */
  static createDevelopment(targetFace: Face, sketchPlane: Plane): Development {
    const surfaceType = FaceQuery.getSurfaceTypeRaw(targetFace.getShape());

    if (surfaceType === 'cylinder') {
      const cylinder = FaceQuery.getSurfaceAdaptorCylinderRaw(targetFace.getShape());
      const axis = cylinder.Axis();
      const spec = {
        origin: Convert.toPoint(axis.Location(), true),
        axisDir: Convert.toVector3dFromGpDir(axis.Direction(), true),
        radius: cylinder.Radius(),
      };
      axis.delete();
      cylinder.delete();
      return new CylinderDevelopment(spec, sketchPlane);
    }

    if (surfaceType === 'cone') {
      const cone = FaceQuery.getSurfaceAdaptorConeRaw(targetFace.getShape());
      const axis = cone.Axis();
      const spec = {
        origin: Convert.toPoint(axis.Location(), true),
        axisDir: Convert.toVector3dFromGpDir(axis.Direction(), true),
        refRadius: cone.RefRadius(),
        semiAngle: cone.SemiAngle(),
      };
      axis.delete();
      cone.delete();
      return new ConeDevelopment(spec, sketchPlane);
    }

    throw new Error(`wrap() requires a cylindrical or conical target face, got a ${surfaceType} face`);
  }

  /**
   * Whether the target face's material-outward normal points toward the
   * surface axis (a bore wall) rather than away from it (an outer wall).
   * The TopAbs orientation flag alone cannot tell: prism-swept lateral
   * faces carry a reverse-parameterized surface (intrinsic normal inward,
   * flag REVERSED) yet still face away from the axis.
   */
  private static isInwardFacing(targetFace: Face, development: Development): boolean {
    const probe = WrapOps.probeFace(targetFace);
    return probe.normal.dot(development.surfaceNormalAt(probe.point)) < 0;
  }

  /** Builds the recentered Geom surface (sketch anchor at u = 0). */
  private static makeSurface(development: Development): Geom_Surface {
    const oc = getOC();
    const [origin, disposeOrigin] = Convert.toGpPnt(development.origin);
    const [zDir, disposeZ] = Convert.toGpDir(development.axisDir);
    const [xDir, disposeX] = Convert.toGpDir(development.xDir);
    const frame = new oc.gp_Ax3(origin, zDir, xDir);

    const surface = development.kind === 'cylinder'
      ? new oc.Geom_CylindricalSurface(frame, development.radius)
      : new oc.Geom_ConicalSurface(frame, development.semiAngle, development.refRadius);

    frame.delete();
    disposeX();
    disposeZ();
    disposeOrigin();
    return surface;
  }

  /** Maps one planar region face onto the surface as a face with pcurve boundaries. */
  private static wrapRegion(region: Face, sketchPlane: Plane, development: Development, surface: Geom_Surface): TopoDS_Face {
    const oc = getOC();
    const regionFace = oc.TopoDS.Face(region.getShape());
    const outerWire = oc.BRepTools.OuterWire(regionFace);
    const span = new UvSpan();

    let outerUv: TopoDS_Wire | null = null;
    const holesUv: TopoDS_Wire[] = [];
    for (const wire of region.getWires()) {
      const isOuter = wire.getShape().IsSame(outerWire);
      const uvWire = WrapOps.mapWire(wire, sketchPlane, development, surface, span);
      const oriented = WrapOps.orientUvWire(uvWire, wire, sketchPlane, development, isOuter);
      if (isOuter) {
        outerUv = oriented;
      } else {
        holesUv.push(oriented);
      }
    }

    if (!outerUv) {
      throw new Error("wrap(): could not identify the outer boundary of a sketch region");
    }
    span.assertWithinOneTurn();

    const maker = new oc.BRepBuilderAPI_MakeFace(surface, outerUv, true);
    for (const hole of holesUv) {
      maker.Add(hole);
    }
    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("wrap(): failed to build the wrapped face on the target surface");
    }
    const rawFace = maker.Face();
    maker.delete();

    oc.BRepLib.BuildCurves3d(rawFace);

    // Belt and suspenders for remaining surface-specific issues (the wire
    // windings themselves are already enforced by orientUvWire — ShapeFix
    // does NOT reliably fix multi-wire faces on periodic surfaces).
    const fix = new oc.ShapeFix_Face(rawFace);
    fix.Perform();
    const fixedFace = fix.Face();
    fix.delete();
    return fixedFace;
  }

  /**
   * Enforces the winding the face builder needs: the outer boundary
   * counter-clockwise in UV (material to its left on the surface), holes
   * clockwise. The mapped wire inherits the planar wire's winding through the
   * development (possibly mirrored), so measure the source and reverse the UV
   * wire when it lands the wrong way.
   */
  private static orientUvWire(uvWire: TopoDS_Wire, sourceWire: Wire, sketchPlane: Plane, development: Development, isOuter: boolean): TopoDS_Wire {
    const planarCW = WireOps.isCWRaw(sourceWire.getShape(), sketchPlane.normal);
    const uvCW = development.isOrientationPreserving() ? planarCW : !planarCW;
    const wantCW = !isOuter;
    if (uvCW === wantCW) {
      return uvWire;
    }
    return WireOps.reverseWireRaw(uvWire);
  }

  /** Maps a planar wire into a wire of edges with pcurves on the surface. */
  private static mapWire(wire: Wire, sketchPlane: Plane, development: Development, surface: Geom_Surface, span: UvSpan): TopoDS_Wire {
    const uvEdges = wire.getEdges().flatMap(edge => WrapOps.mapEdge(edge, sketchPlane, development, surface, span));
    return WireOps.makeWireFromEdgesRaw(uvEdges);
  }

  /**
   * Maps one sketch edge onto the surface, following the source wire's
   * traversal direction (reversed edges are sampled back to front) so the
   * assembled UV wire winds the same way as the planar wire it came from.
   * Straight edges on cylinders map to exact UV lines (the development is
   * affine there); everything else is sampled along the curve and fitted with
   * a 2D B-spline. Closed edges (e.g. full circles) are split into two halves
   * so the resulting wire has topologically distinct vertices.
   */
  private static mapEdge(edge: Edge, sketchPlane: Plane, development: Development, surface: Geom_Surface, span: UvSpan): TopoDS_Edge[] {
    const oc = getOC();
    const reversed = edge.getShape().Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const adaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge.getShape()));
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();

      const isLine = adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
      if (isLine && development.kind === 'cylinder') {
        const start = WrapOps.mapPoint(adaptor, reversed ? last : first, sketchPlane, development, span);
        const end = WrapOps.mapPoint(adaptor, reversed ? first : last, sketchPlane, development, span);
        return [WrapOps.makeUvLineEdge(start, end, surface)];
      }

      const samples: UV[] = [];
      for (let i = 0; i <= CURVED_EDGE_SAMPLES; i++) {
        const t = first + ((last - first) * i) / CURVED_EDGE_SAMPLES;
        samples.push(WrapOps.mapPoint(adaptor, t, sketchPlane, development, span));
      }
      if (reversed) {
        samples.reverse();
      }

      const start = samples[0];
      const end = samples[samples.length - 1];
      const isClosed = Math.hypot(end.u - start.u, end.v - start.v) < 1e-9;
      if (isClosed) {
        const mid = Math.floor(samples.length / 2);
        return [
          WrapOps.makeFittedUvEdge(samples.slice(0, mid + 1), surface),
          WrapOps.makeFittedUvEdge(samples.slice(mid), surface),
        ];
      }

      return [WrapOps.makeFittedUvEdge(samples, surface)];
    } finally {
      adaptor.delete();
    }
  }

  private static mapPoint(adaptor: BRepAdaptor_Curve, t: number, sketchPlane: Plane, development: Development, span: UvSpan): UV {
    const point = Convert.toPoint(adaptor.Value(t), true);
    const uv = development.toUV(sketchPlane.worldToLocal(point));
    span.add(uv.u);
    return uv;
  }

  private static makeFittedUvEdge(samples: UV[], surface: Geom_Surface): TopoDS_Edge {
    const oc = getOC();
    const curve = WrapOps.fitUvCurve(samples);
    const maker = new oc.BRepBuilderAPI_MakeEdge(curve, surface);
    const result = maker.Edge();
    maker.delete();
    curve.delete();
    return result;
  }

  private static makeUvLineEdge(start: UV, end: UV, surface: Geom_Surface): TopoDS_Edge {
    const oc = getOC();
    const du = end.u - start.u;
    const dv = end.v - start.v;
    const length = Math.hypot(du, dv);

    const point = new oc.gp_Pnt2d(start.u, start.v);
    const direction = new oc.gp_Dir2d(du, dv);
    const line = new oc.Geom2d_Line(point, direction);
    const maker = new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, length);
    const result = maker.Edge();
    maker.delete();
    line.delete();
    direction.delete();
    point.delete();
    return result;
  }

  /**
   * Interpolates the developed UV samples of one sketch edge with a 2D
   * B-spline that passes exactly through every sample (so adjacent wire
   * edges meet bit-exactly — no endpoint snapping needed).
   *
   * The poles/knots are computed in-house: fluidcad-ocjs currently
   * miscompiles `Geom2dAPI_PointsToBSpline` — both its array constructors
   * (NaN poles) and its `Init` path (the "fit" of a clean semicircle bulged
   * 70% past the samples). `Geom2d_BSplineCurve`'s array constructor is
   * unaffected.
   */
  private static fitUvCurve(samples: UV[]): Geom2d_BSplineCurve {
    const oc = getOC();
    const data = interpolateBSpline2d(samples.map(s => ({ x: s.u, y: s.v })));

    const poles = new oc.NCollection_Array1_gp_Pnt2d(1, data.poles.length);
    for (let i = 0; i < data.poles.length; i++) {
      const point = new oc.gp_Pnt2d(data.poles[i].x, data.poles[i].y);
      poles.SetValue(i + 1, point);
      point.delete();
    }
    const knots = new oc.NCollection_Array1_double(1, data.knots.length);
    const multiplicities = new oc.NCollection_Array1_int(1, data.knots.length);
    for (let i = 0; i < data.knots.length; i++) {
      knots.SetValue(i + 1, data.knots[i]);
      multiplicities.SetValue(i + 1, data.multiplicities[i]);
    }

    const curve = new oc.Geom2d_BSplineCurve(poles, knots, multiplicities, data.degree);
    poles.delete();
    knots.delete();
    multiplicities.delete();
    return curve;
  }

  /** Thickens the wrapped face along the surface normal into a solid. */
  private static thicken(wrappedFace: TopoDS_Face, offset: number): Shape[] {
    const oc = getOC();
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    maker.MakeThickSolidBySimple(wrappedFace, offset);
    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("wrap(): thickening the wrapped face failed");
    }
    const shape = maker.Shape();
    maker.delete();

    const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum;
    const solids = Explorer.findShapes(shape, SOLID);
    if (solids.length === 0) {
      throw new Error("wrap(): thickening the wrapped face did not produce a solid");
    }

    return solids.map(solid => {
      const typedSolid = oc.TopoDS.Solid(solid);
      oc.BRepLib.OrientClosedSolid(typedSolid);
      return ShapeFactory.fromShape(typedSolid);
    });
  }

  /**
   * Classifies the thickened solid's faces. The wrapped base face survives
   * thickening unchanged (start); the only other face whose normal is aligned
   * with the surface normal is the offset face (end); the remaining walls are
   * split into internal (sharing an edge with a sketch hole) and side.
   */
  private static classify(solids: Shape[], baseFace: TopoDS_Face, development: Development, out: WrapResult): void {
    const holeEdges = WrapOps.collectHoleEdges(baseFace);

    for (const solid of solids) {
      out.solids.push(solid);
      for (const shape of Explorer.findFacesWrapped(solid)) {
        const face = shape as Face;
        if (face.getShape().IsSame(baseFace)) {
          out.startFaces.push(face);
          continue;
        }

        const probe = WrapOps.probeFace(face);
        const aligned = Math.abs(probe.normal.dot(development.surfaceNormalAt(probe.point))) > ALIGNED_NORMAL_THRESHOLD;
        if (aligned) {
          out.endFaces.push(face);
        } else if (WrapOps.sharesEdgeWith(face, holeEdges)) {
          out.internalFaces.push(face);
        } else {
          out.sideFaces.push(face);
        }
      }
    }
  }

  private static collectHoleEdges(face: TopoDS_Face): TopoDS_Edge[] {
    const oc = getOC();
    const outerWire = oc.BRepTools.OuterWire(face);
    const WIRE = oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;

    const holeEdges: TopoDS_Edge[] = [];
    for (const wire of Explorer.findShapes(face, WIRE)) {
      if (wire.IsSame(outerWire)) {
        continue;
      }
      for (const edge of Explorer.findShapes(wire, EDGE)) {
        holeEdges.push(oc.TopoDS.Edge(edge));
      }
    }
    return holeEdges;
  }

  private static sharesEdgeWith(face: Face, edges: TopoDS_Edge[]): boolean {
    if (edges.length === 0) {
      return false;
    }
    return face.getEdges().some(faceEdge => edges.some(edge => faceEdge.getShape().IsSame(edge)));
  }

  /**
   * Samples the face at the middle of its UV bounds: the surface point and
   * the material-outward normal (oriented by the face's TopAbs flag) at that
   * SAME parameter. Classification compares this normal against the
   * development normal at the sampled point — sampling both at one location
   * keeps the comparison angle-independent on periodic surfaces, where the
   * normal rotates with u (a normal taken anywhere else drifts by the angular
   * distance and breaks the alignment test past ~45°).
   */
  private static probeFace(face: Face): { point: Point; normal: Vector3d } {
    const oc = getOC();
    const rawFace = oc.TopoDS.Face(face.getShape());
    const bounds = oc.BRepTools.UVBounds(rawFace);
    const u = (bounds.UMin + bounds.UMax) / 2;
    const v = (bounds.VMin + bounds.VMax) / 2;

    const surface = oc.BRep_Tool.Surface(rawFace);
    const props = new oc.GeomLProp_SLProps(surface, u, v, 1, 1e-6);
    let rawNormal = props.Normal();
    if (rawFace.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
      rawNormal = rawNormal.Reversed();
    }
    const normal = Convert.toVector3dFromGpDir(rawNormal);
    const point = Convert.toPoint(props.Value(), true);
    props.delete();
    surface.delete();

    return { point, normal };
  }
}
