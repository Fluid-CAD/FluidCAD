import type { gp_Pln, TopoDS_Edge, TopoDS_Wire } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Wire } from "../common/wire.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Plane } from "../math/plane.js";
import { WireOps } from "./wire-ops.js";
import { rad } from "../helpers/math-helpers.js";

export class FilletOps {
  static makeFillet(solid: Shape, edges: Edge[], radius: number): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeFillet(solid.getShape(), oc.ChFi3d_FilletShape.ChFi3d_Rational);

    for (const edge of edges) {
      maker.Add(radius, oc.TopoDS.Edge(edge.getShape()));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create fillet.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static makeChamfer(solid: Shape, edges: Edge[], distance: number): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (const edge of edges) {
      maker.Add(distance, oc.TopoDS.Edge(edge.getShape()));
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static makeChamferTwoDistances(solid: Shape, edges: Edge[], distance1: number, distance2: number, faces: Face[], isAngle: boolean = false): Shape {
    const oc = getOC();
    const maker = new oc.BRepFilletAPI_MakeChamfer(solid.getShape());

    for (let i = 0; i < edges.length; i++) {
      const face = faces[i];
      if (!face) {
        throw new Error("Chamfer: Failed to find common face for chamfer.");
      }

      if (isAngle) {
        maker.AddDA(distance1, rad(distance2), oc.TopoDS.Edge(edges[i].getShape()), oc.TopoDS.Face(face.getShape()));
      } else {
        maker.Add(distance1, distance2, oc.TopoDS.Edge(edges[i].getShape()), oc.TopoDS.Face(face.getShape()));
      }
    }

    const progress = new oc.Message_ProgressRange();
    maker.Build(progress);
    progress.delete();

    if (!maker.IsDone()) {
      maker.delete();
      throw new Error("Failed to create chamfer.");
    }

    const result = maker.Shape();
    maker.delete();
    return ShapeFactory.fromShape(result);
  }

  static fillet2d(shape: Wire | Edge, plane: Plane, radius: number): Wire {
    const wire = shape instanceof Wire ? shape : WireOps.makeWireFromEdges([shape]);
    const [pln, disposePln] = Convert.toGpPln(plane);
    const result = FilletOps.fillet2dRaw(wire.getShape() as TopoDS_Wire, pln, radius);
    disposePln();
    return Wire.fromTopoDSWire(result);
  }

  static fillet2dRaw(wire: TopoDS_Wire, plane: gp_Pln, radius: number): TopoDS_Wire {
    const oc = getOC();
    const isClosed = wire.Closed();
    const ownedEdges: TopoDS_Edge[] = [];

    // Extract edges in wire traversal order and canonicalize: for each REVERSED edge,
    // build a new FORWARD edge whose natural parameterization matches the wire traversal.
    // ChFi2d_FilletAPI returns modified edges whose natural direction matches the input's
    // natural direction, so aligning natural direction with wire traversal makes the
    // modEdges directly usable when rebuilding the final wire.
    const wireEdges: TopoDS_Edge[] = [];
    {
      const explorer = new oc.BRepTools_WireExplorer(wire);
      while (explorer.More()) {
        const raw = oc.TopoDS.Edge(explorer.Current());
        const isReversed = raw.Orientation().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value;
        if (!isReversed) {
          wireEdges.push(raw);
          ownedEdges.push(raw);
        } else {
          const adaptor = new oc.BRepAdaptor_Curve(raw);
          const edgeFirst = adaptor.FirstParameter();
          const edgeLast = adaptor.LastParameter();
          adaptor.delete();

          const curveHandle = oc.BRep_Tool.Curve(raw, 0, 1);
          if (!curveHandle || curveHandle.IsNull()) {
            raw.delete();
            explorer.delete();
            ownedEdges.forEach(e => e.delete());
            throw new Error("fillet2d: edge has no 3D curve");
          }
          const curve = curveHandle.get();
          const reversedHandle = curve.Reversed();
          const newFirst = curve.ReversedParameter(edgeLast);
          const newLast = curve.ReversedParameter(edgeFirst);
          const maker = new oc.BRepBuilderAPI_MakeEdge(reversedHandle, newFirst, newLast);
          const newEdge = oc.TopoDS.Edge(maker.Edge());
          maker.delete();
          reversedHandle.delete();
          curveHandle.delete();
          raw.delete();
          wireEdges.push(newEdge);
          ownedEdges.push(newEdge);
        }
        explorer.Next();
      }
      explorer.delete();
    }

    const currentEdges: TopoDS_Edge[] = wireEdges.slice();
    const filletArcs = new Map<number, TopoDS_Edge>();
    const maxCorners = isClosed ? currentEdges.length : currentEdges.length - 1;

    for (let cornerIndex = 0; cornerIndex < maxCorners; cornerIndex++) {
      const nextIndex = (cornerIndex + 1) % currentEdges.length;
      const edge1 = currentEdges[cornerIndex];
      const edge2 = currentEdges[nextIndex];

      const sharedVertex = oc.TopExp.LastVertex(edge1, true);
      const sharedPoint = oc.BRep_Tool.Pnt(sharedVertex);
      sharedVertex.delete();

      const filletAPI = new oc.ChFi2d_FilletAPI(edge1, edge2, plane);
      const success = filletAPI.Perform(radius);

      if (!success || filletAPI.NbResults(sharedPoint) === 0) {
        sharedPoint.delete();
        filletAPI.delete();
        continue;
      }

      const modEdge1 = new oc.TopoDS_Edge();
      const modEdge2 = new oc.TopoDS_Edge();
      const filletEdge = filletAPI.Result(sharedPoint, modEdge1, modEdge2, -1);
      sharedPoint.delete();
      filletAPI.delete();

      currentEdges[cornerIndex] = modEdge1;
      currentEdges[nextIndex] = modEdge2;
      filletArcs.set(cornerIndex, filletEdge);
      ownedEdges.push(modEdge1, modEdge2, filletEdge);
    }

    const edgeList = new oc.TopTools_ListOfShape();
    for (let i = 0; i < currentEdges.length; i++) {
      edgeList.Append(oc.TopoDS.Edge(currentEdges[i]));
      const arc = filletArcs.get(i);
      if (arc) {
        edgeList.Append(oc.TopoDS.Edge(arc));
      }
    }

    const wireBuilder = new oc.BRepBuilderAPI_MakeWire();
    wireBuilder.Add(edgeList);
    edgeList.delete();

    if (!wireBuilder.IsDone()) {
      wireBuilder.delete();
      ownedEdges.forEach(e => e.delete());
      throw new Error("fillet2d: failed to build filleted wire");
    }

    const result = wireBuilder.Wire();
    wireBuilder.delete();
    ownedEdges.forEach(e => e.delete());
    return result;
  }
}
