import type {
  BRepProj_Projection,
  TopAbs_ShapeEnum,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Wire,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Plane } from "../math/plane.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { FaceQuery } from "./face-query.js";
import { Matrix4 } from "../math/matrix4.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";
import { HiddenEdges } from "./hidden-edges.js";
import { Explorer } from "./explorer.js";
import { AnalyticEdgeProjection } from "./projection/analytic-projection.js";
import { SilhouetteOps } from "./projection/silhouette.js";
import { WireOps } from "./wire-ops.js";
import { BooleanBuilders } from "./boolean-builders.js";
import { mmTol } from "../units/tolerance.js";

/**
 * Curve projection: the sketch projector, which lays 3D edges, faces and
 * wires onto a sketch plane (`projectEdgeOntoPlane` and its siblings), and
 * the projected curve's two ways of throwing a wire onto faces —
 * {@link alongDirection} and {@link normal}. (`lib/oc/projection/` is the
 * drawing-view projector, an unrelated thing.)
 */
export class ProjectionOps {

  static projectEdgeOntoPlane(targetPlane: Plane, edge: Edge): Edge[] {
    return ProjectionOps.projectEdgesOntoPlane(targetPlane, [edge]);
  }

  static projectWireOntoPlane(targetPlane: Plane, wire: Wire): Edge[] {
    const oc = getOC();
    const topDSWire  = wire.getShape() as TopoDS_Wire;
    const wirePlaneFinder = new oc.BRepBuilderAPI_FindPlane(topDSWire, oc.Precision.Confusion());

    let wirePlane: Plane;
    if (wirePlaneFinder.Found()) {
      const handle = wirePlaneFinder.Plane();
      const geomPln = handle;
      const pln = geomPln.Pln();
      wirePlane = Convert.toPlane(pln);
      // geomPln.delete();
      // handle.delete();
    }

    if (wirePlane && wirePlane.isParallelTo(targetPlane)) {
      // Translation along the target normal that moves a point from the wire
      // plane onto the target plane. Use the *signed* distance — `distanceToPlane`
      // is abs-valued and picks the wrong direction when the wire sits on the
      // negative side of the target normal.
      const signedDist = targetPlane.signedDistanceToPoint(wirePlane.origin);
      const translation = targetPlane.normal.multiply(-signedDist);
      const matrix = Matrix4.fromTranslation(translation.x, translation.y, translation.z);
      const transformed = ShapeOps.transform(wire, matrix) as Wire;
      return transformed.getEdges();
    }

    return ProjectionOps.projectEdgesOntoPlane(targetPlane, wire.getEdges());
  }

  /**
   * A face projects as its boundary edges plus, for a curved face, its
   * outline edges against the sketch normal — a side-on cylinder is a
   * rectangle, not its two end circles. Seams and degenerate edges are not
   * geometry the face shows (see HiddenEdges) and are left out.
   */
  static projectFaceOntoPlane(targetPlane: Plane, face: Face): Edge[] {
    let facePlane: Plane | null = null;
    try {
      facePlane = face.getPlane();
    } catch {
      // Non-planar face (cylinder, cone, sphere, etc.) — fall through to normal projection
    }

    if (facePlane) {
      const parallel = FaceQuery.isFaceParallelToPlane(face, targetPlane);
      const coplanar = FaceQuery.isFaceOnPlane(face, targetPlane);

      if (parallel || coplanar) {
        const wires = face.getWires();
        const signedDist = targetPlane.signedDistanceToPoint(facePlane.origin);
        const translation = targetPlane.normal.multiply(-signedDist);
        let matrix = Matrix4.fromTranslation(translation.x, translation.y, translation.z);
        return wires.flatMap(wire => (ShapeOps.transform(wire, matrix) as Wire).getEdges());
      }
    }

    const rawFace = face.getShape() as TopoDS_Face;
    const hidden = HiddenEdges.ofFace(rawFace);
    const boundary = face.getWires()
      .flatMap(wire => wire.getEdges())
      .filter(edge => !hidden.some(h => h.IsSame(edge.getShape())));
    Explorer.deleteAll(hidden);
    const outlines = facePlane
      ? []
      : SilhouetteOps.outlineEdgesRaw(rawFace, targetPlane.normal).map(e => Edge.fromTopoDSEdge(e));

    return ProjectionOps.projectEdgesOntoPlane(targetPlane, [...boundary, ...outlines]);
  }

  /**
   * Edge by edge: lines and circles project exactly (see
   * AnalyticEdgeProjection), everything else goes through the normal
   * projection in one batch.
   */
  private static projectEdgesOntoPlane(targetPlane: Plane, edges: Edge[]): Edge[] {
    const projected: Edge[] = [];
    const general: TopoDS_Edge[] = [];
    for (const edge of edges) {
      const raw = edge.getShape() as TopoDS_Edge;
      const analytic = AnalyticEdgeProjection.projectRaw(raw, targetPlane);
      if (analytic?.kind === 'edge') {
        projected.push(Edge.fromTopoDSEdge(analytic.edge));
      } else if (!analytic) {
        general.push(raw);
      }
    }

    if (general.length > 0) {
      const [pln, disposePln] = Convert.toGpPln(targetPlane);
      const planeFace = FaceOps.makeFaceFromPlane(pln);
      for (const raw of ProjectionOps.normalProject(general, planeFace)) {
        projected.push(Edge.fromTopoDSEdge(raw));
      }
      disposePln();
    }
    return projected;
  }

  /**
   * The projected edges of `shapes` on the sketch plane's face, which is
   * unbounded: the projection runs on past the face's (absent) boundary.
   */
  private static normalProject(shapes: TopoDS_Shape[], targetFace: TopoDS_Face): TopoDS_Edge[] {
    return ProjectionOps.normalProjectionEdges(shapes, targetFace, false);
  }

  /**
   * Every image of `wire` on `target` along the line of `direction`, both
   * ways: the near side and the far side of a body alike, as wires, one per
   * connected chain, in no promised order.
   *
   * `BRepProj_Projection` sweeps a prism from the wire both ways along the
   * direction and sections it with the target's faces. An edge of that
   * section lying on one line along the direction — where the prism meets a
   * face the direction lies in, as a box's end wall — is the image of a
   * single point of the wire, not of a stretch of it, and is left out. What
   * is left is chained again (`WireOps.chainEdges`), so an image the kernel
   * split at a closed face's seam is one wire.
   *
   * Empty when nothing lands on the target, or when the kernel refuses the
   * input (a wire running along the direction sweeps no prism). Each edge
   * carries its curve on the target face it lies on.
   */
  static alongDirection(wire: Wire, target: TopoDS_Shape, direction: Vector3d): Wire[] {
    const oc = getOC();
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const unit = direction.normalize();
    const dir = new oc.gp_Dir(unit.x, unit.y, unit.z);
    const edges: Edge[] = [];
    let projection: BRepProj_Projection | null = null;
    try {
      projection = new oc.BRepProj_Projection(wire.getShape(), target, dir);
      if (projection.IsDone()) {
        for (projection.Init(); projection.More(); projection.Next()) {
          // Every Current() is a fresh copy of the result wire.
          const current = projection.Current();
          try {
            for (const raw of Explorer.findShapes(current, EDGE)) {
              edges.push(Edge.fromTopoDSEdge(oc.TopoDS.Edge(raw)));
              raw.delete();
            }
          } finally {
            current.delete();
          }
        }
      }
    } catch {
      // The kernel refused the input: no image.
      edges.forEach(edge => edge.dispose());
      return [];
    } finally {
      projection?.delete();
      dir.delete();
    }

    const kept: Edge[] = [];
    for (const edge of edges) {
      if (ProjectionOps.liesAlong(edge, unit)) {
        edge.dispose();
      } else {
        kept.push(edge);
      }
    }
    try {
      return kept.length === 0 ? [] : WireOps.chainEdges(kept);
    } finally {
      // The wires hold the edges they were built from.
      kept.forEach(edge => edge.dispose());
    }
  }

  /**
   * The wires with each edge split where it folds back across `direction`:
   * where, seen along the direction, the curve turns round — the silhouette
   * of the face it lies on, where the image of a stretch of the source
   * passes from the near side of the face to its far side (a line across a
   * ball lands on it as one circle, folding at either side). What a choice
   * between the near side and the far side needs, since the two meet there.
   * The pieces keep their curves on the faces they lie on, and are chained
   * again; the wires given are freed when replaced, and returned as they are
   * when nothing folds (or the kernel cannot split them).
   */
  static splitAtFolds(wires: Wire[], direction: Vector3d): Wire[] {
    const unit = direction.normalize();
    const edges = wires.flatMap(wire => wire.getEdges());
    const folds = edges.flatMap(edge => ProjectionOps.foldsOf(edge, unit));
    if (folds.length === 0) {
      return wires;
    }
    const oc = getOC();
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const args = new oc.TopTools_ListOfShape();
    const tools = new oc.TopTools_ListOfShape();
    const splitter = new oc.BRepAlgoAPI_Splitter();
    const progress = new oc.Message_ProgressRange();
    let pieces: Edge[] = [];
    try {
      for (const edge of edges) {
        args.Append(edge.getShape()).delete();
      }
      for (const fold of folds) {
        const at = new oc.gp_Pnt(fold.x, fold.y, fold.z);
        const maker = new oc.BRepBuilderAPI_MakeVertex(at);
        const vertex = maker.Vertex();
        tools.Append(vertex).delete();
        vertex.delete();
        maker.delete();
        at.delete();
      }
      splitter.SetArguments(args);
      splitter.SetTools(tools);
      splitter.Build(progress);
      if (!splitter.IsDone() || splitter.HasErrors()) {
        return wires;
      }
      const result = splitter.Shape();
      try {
        pieces = Explorer.findShapes(result, EDGE).map(raw => {
          const piece = Edge.fromTopoDSEdge(oc.TopoDS.Edge(raw));
          raw.delete();
          return piece;
        });
      } finally {
        result.delete();
      }
    } catch {
      pieces.forEach(piece => piece.dispose());
      return wires;
    } finally {
      progress.delete();
      BooleanBuilders.release(splitter);
      tools.delete();
      args.delete();
    }
    try {
      const chained = WireOps.chainEdges(pieces);
      wires.forEach(wire => wire.dispose());
      return chained;
    } finally {
      pieces.forEach(piece => piece.dispose());
    }
  }

  /**
   * Where `edge` folds back across `direction` (a unit vector): the points
   * inside it where its tangent, the part along the direction taken out,
   * turns round. Found between samples whose tangents across the direction
   * point apart, then pinned down by halving.
   */
  private static foldsOf(edge: Edge, direction: Vector3d): Point[] {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge.getShape() as TopoDS_Edge);
    const point = new oc.gp_Pnt();
    const vector = new oc.gp_Vec();
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const across = (t: number) => {
        adaptor.D1(t, point, vector);
        const tangent = new Vector3d(vector.X(), vector.Y(), vector.Z());
        return tangent.subtract(direction.multiply(tangent.dot(direction)));
      };
      const margin = (last - first) * 1e-6;
      const samples = 32;
      const folds: Point[] = [];
      let previous = across(first);
      for (let i = 1; i <= samples; i++) {
        const t = first + (last - first) * i / samples;
        const current = across(t);
        if (previous.dot(current) < 0) {
          let lo = first + (last - first) * (i - 1) / samples;
          let hi = t;
          for (let k = 0; k < 48; k++) {
            const middle = (lo + hi) / 2;
            if (across(middle).dot(previous) > 0) {
              lo = middle;
            } else {
              hi = middle;
            }
          }
          const fold = (lo + hi) / 2;
          if (fold - first > margin && last - fold > margin) {
            const value = adaptor.Value(fold);
            folds.push(new Point(value.X(), value.Y(), value.Z()));
            value.delete();
          }
        }
        previous = current;
      }
      return folds;
    } finally {
      vector.delete();
      point.delete();
      adaptor.delete();
    }
  }

  /**
   * The image of `wire` on `target` by closest point: every point of the
   * wire goes to the nearest point of a target face, the image cut to each
   * face's boundary. One wire per connected chain, in no promised order: a
   * face region the wire reaches gives one, and an image the kernel split at
   * a seam or across faces is chained into one (`WireOps.chainEdges`). Empty
   * when nothing lands on the target. Each edge carries its curve on the
   * target face it lies on.
   */
  static normal(wire: Wire, target: TopoDS_Shape): Wire[] {
    const pieces = ProjectionOps.normalPieces(wire);
    try {
      const edges = ProjectionOps.normalProjectionEdges(pieces ?? [wire.getShape()], target, true)
        .map(raw => Edge.fromTopoDSEdge(raw));
      try {
        return edges.length === 0 ? [] : WireOps.chainEdges(edges);
      } finally {
        edges.forEach(edge => edge.dispose());
      }
    } finally {
      pieces?.forEach(piece => piece.delete());
    }
  }

  /** The most a source edge's tangent may turn in one piece handed to the normal projector: one turn. */
  private static readonly NORMAL_PIECE_TURNING = 2 * Math.PI;

  /**
   * The wire's edges cut into pieces that each turn at most one turn
   * ({@link NORMAL_PIECE_TURNING}), for the normal projector — or null when
   * no edge turns more than that, and the wire goes in whole. The projector
   * walks a long winding curve badly: a helix of five turns came back as
   * three stretches with a whole turn missing between each, while each of
   * its turns projected on its own comes back whole and chains into one
   * wire again. The pieces are the caller's to free.
   */
  private static normalPieces(wire: Wire): TopoDS_Shape[] | null {
    const edges = wire.getEdges();
    const counts = edges.map(edge => Math.max(1,
      Math.ceil(ProjectionOps.turningOf(edge.getShape() as TopoDS_Edge) / ProjectionOps.NORMAL_PIECE_TURNING - 1e-9)));
    if (counts.every(count => count === 1)) {
      return null;
    }
    const oc = getOC();
    const pieces: TopoDS_Shape[] = [];
    try {
      edges.forEach((edge, index) => {
        const info = oc.BRep_Tool.Curve(edge.getShape() as TopoDS_Edge, 0, 1);
        try {
          const count = counts[index];
          for (let i = 0; i < count; i++) {
            const from = info.First + (info.Last - info.First) * i / count;
            const to = info.First + (info.Last - info.First) * (i + 1) / count;
            const maker = new oc.BRepBuilderAPI_MakeEdge(info.returnValue, from, to);
            try {
              if (maker.IsDone()) {
                pieces.push(maker.Edge());
              }
            } finally {
              maker.delete();
            }
          }
        } finally {
          // The curve handle the read hands back is the caller's to release.
          info[Symbol.dispose]();
        }
      });
    } catch (error) {
      pieces.forEach(piece => piece.delete());
      throw error;
    }
    return pieces;
  }

  /**
   * How far an edge's tangent turns from one end to the other, in radians:
   * the angles between the tangents at evenly spaced points, summed, the
   * spacing halved until no step turns more than an eighth of a turn (a
   * line 0, a circle 2π, a helix about 2π a turn).
   */
  private static turningOf(edge: TopoDS_Edge): number {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const point = new oc.gp_Pnt();
    const tangent = new oc.gp_Vec();
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const tangentAt = (u: number): Vector3d | null => {
        adaptor.D1(u, point, tangent);
        const length = tangent.Magnitude();
        return length > 1e-12 ? new Vector3d(tangent.X() / length, tangent.Y() / length, tangent.Z() / length) : null;
      };
      for (let samples = 64; ; samples *= 2) {
        let total = 0;
        let widest = 0;
        let previous = tangentAt(first);
        for (let i = 1; i <= samples; i++) {
          const next = tangentAt(first + (last - first) * i / samples);
          if (previous && next) {
            const step = Math.acos(Math.min(1, Math.max(-1, previous.dot(next))));
            total += step;
            widest = Math.max(widest, step);
          }
          previous = next ?? previous;
        }
        if (widest <= Math.PI / 4 || samples >= 4096) {
          return total;
        }
      }
    } finally {
      tangent.delete();
      point.delete();
      adaptor.delete();
    }
  }

  /**
   * The edges `BRepAlgo_NormalProjection` makes of `shapes` on `target`'s
   * faces: the one use of the class, shared by the sketch projector and
   * {@link normal}. With `faceBounds` each image is cut to the faces'
   * boundaries; without, it runs on over each face's whole surface.
   *
   * Read from the projector's result compound, not BuildWire(): that chains
   * the results into wires and answers nothing at all for a batch of
   * disjoint edges (two outline generatrices, say), while the compound
   * always carries every projected edge. Empty when the kernel fails.
   */
  private static normalProjectionEdges(shapes: TopoDS_Shape[], target: TopoDS_Shape, faceBounds: boolean): TopoDS_Edge[] {
    const oc = getOC();
    const projector = new oc.BRepAlgo_NormalProjection(target);
    try {
      projector.SetLimit(faceBounds);
      for (const shape of shapes) {
        projector.Add(shape);
      }
      projector.Build();
      if (!projector.IsDone()) {
        return [];
      }
      const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
      const result = projector.Projection();
      try {
        return Explorer.findShapes(result, EDGE).map(raw => {
          const edge = oc.TopoDS.Edge(raw);
          raw.delete();
          return edge;
        });
      } finally {
        result.delete();
      }
    } catch (e) {
      console.error('Normal projection failed:', e);
      return [];
    } finally {
      projector.delete();
    }
  }

  /**
   * Whether `edge` lies on one line along `direction` (a unit vector): its
   * ends and three points between them within the edge's tolerance of the
   * line through its start.
   */
  private static liesAlong(edge: Edge, direction: Vector3d): boolean {
    const oc = getOC();
    const raw = edge.getShape() as TopoDS_Edge;
    const tolerance = Math.max(oc.BRep_Tool.Tolerance(raw), mmTol(1e-5));
    const adaptor = new oc.BRepAdaptor_Curve(raw);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      let origin: Point | null = null;
      for (let i = 0; i <= 4; i++) {
        const value = adaptor.Value(first + (last - first) * i / 4);
        const point = new Point(value.X(), value.Y(), value.Z());
        value.delete();
        if (!origin) {
          origin = point;
          continue;
        }
        const offset = origin.vectorTo(point);
        if (offset.subtract(direction.multiply(offset.dot(direction))).length() > tolerance) {
          return false;
        }
      }
      return true;
    } finally {
      adaptor.delete();
    }
  }
}
