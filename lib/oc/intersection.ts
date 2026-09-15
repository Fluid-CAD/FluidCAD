import type {
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
import { Edge } from "../common/edge.js";
import { HiddenEdges } from "./hidden-edges.js";
import { Explorer } from "./explorer.js";
import { AnalyticEdgeProjection } from "./projection/analytic-projection.js";
import { SilhouetteOps } from "./projection/silhouette.js";

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
   * The projected edges of `shapes`, read from the projector's result
   * compound. Not BuildWire(): it chains the results into wires and answers
   * nothing at all for a batch of disjoint edges (two outline generatrices,
   * say), while the compound always carries every projected edge.
   */
  private static normalProject(shapes: TopoDS_Shape[], targetFace: TopoDS_Face): TopoDS_Edge[] {
    const oc = getOC();
    const projector = new oc.BRepAlgo_NormalProjection(targetFace);
    try {
      projector.SetLimit(false);
      for (const shape of shapes) {
        projector.Add(shape);
      }
      projector.Build();
      if (!projector.IsDone()) {
        return [];
      }
      const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
      return Explorer.findShapes<TopoDS_Edge>(projector.Projection(), EDGE).map(e => oc.TopoDS.Edge(e));
    } catch (e) {
      console.error('Normal projection failed:', e);
      return [];
    } finally {
      projector.delete();
    }
  }
}
