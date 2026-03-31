import type { TopoDS_Edge, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Axis } from "../math/axis.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { ShapeOps } from "./shape-ops.js";
import { Explorer } from "./explorer.js";

export class EdgeOps {
  // Wrapper methods (public API for external callers)
  static getFirstVertex(edge: Edge): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getFirstVertexRaw(edge.getShape() as TopoDS_Edge));
  }

  static getLastVertex(edge: Edge): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getLastVertexRaw(edge.getShape() as TopoDS_Edge));
  }

  static edgeToAxis(edge: Edge): Axis {
    return EdgeOps.edgeToAxisRaw(edge.getShape() as TopoDS_Edge);
  }

  static axisToEdge(axis: Axis): Edge {
    return Edge.fromTopoDSEdge(EdgeOps.axisToEdgeRaw(axis));
  }

  static getVertexPoint(vertex: Vertex): Point {
    return EdgeOps.getVertexPointRaw(vertex.getShape() as TopoDS_Vertex);
  }

  static getEdgeMidPoint(edge: Edge): Point {
    return EdgeOps.getEdgeMidPointRaw(edge.getShape() as TopoDS_Edge);
  }

  static reverseEdge(edge: Edge): Edge {
    return Edge.fromTopoDSEdge(EdgeOps.reverseEdgeRaw(edge.getShape() as TopoDS_Edge));
  }

  static getEdgeOrientation(edge: Edge): number {
    return EdgeOps.getEdgeOrientationRaw(edge.getShape() as TopoDS_Edge);
  }

  static getEdgeTangentAtEnd(edge: Edge): Vector3d {
    return EdgeOps.getEdgeTangentAtEndRaw(edge.getShape() as TopoDS_Edge);
  }

  static makeEdgeFromCurveAndVertices(curve: any, v1: Vertex, v2: Vertex): Edge {
    return Edge.fromTopoDSEdge(
      EdgeOps.makeEdgeFromCurveAndVerticesRaw(curve, v1.getShape() as TopoDS_Vertex, v2.getShape() as TopoDS_Vertex)
    );
  }

  // Raw methods (for oc-internal and common/ use)
  static getFirstVertexRaw(edge: TopoDS_Edge): TopoDS_Vertex {
    const oc = getOC();
    return oc.TopExp.FirstVertex(edge, true);
  }

  static getLastVertexRaw(edge: TopoDS_Edge): TopoDS_Vertex {
    const oc = getOC();
    return oc.TopExp.LastVertex(edge, true);
  }

  static edgeToAxisRaw(edge: TopoDS_Edge): Axis {
    const oc = getOC();

    const topoEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(topoEdge);

    if (curveAdaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = curveAdaptor.Line();
      const axis = line.Position();

      curveAdaptor.delete();
      line.delete();

      const axisLocation = axis.Location();
      const axisDirection = axis.Direction();

      const result = new Axis(
        Convert.toPoint(axisLocation),
        Convert.toVector3dFromGpDir(axisDirection)
      );

      axisLocation.delete();
      axisDirection.delete();
      axis.delete();

      return result;
    }

    curveAdaptor.delete();
    throw new Error("Edge does not represent a line and cannot be converted to an axis");
  }

  static axisToEdgeRaw(axis: Axis): TopoDS_Edge {
    const oc = getOC();

    const length = 300;

    const start = new oc.gp_Pnt(axis.origin.x + (axis.direction.x * -length),
      axis.origin.y + (axis.direction.y * -length),
      axis.origin.z + (axis.direction.z * -length)
    );

    const end = new oc.gp_Pnt(
      axis.origin.x + (axis.direction.x * length),
      axis.origin.y + (axis.direction.y * length),
      axis.origin.z + (axis.direction.z * length),
    );

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(start, end);
    const edge = edgeMaker.Edge();
    edgeMaker.delete();

    return edge;
  }

  static edgeMiddlePoint(edge: TopoDS_Edge) {
    const oc = getOC();

    const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const curve = curveAdaptor.Curve();

    const midParam = (curve.FirstParameter() + curve.LastParameter()) / 2.0;
    const midPoint = curve.Value(midParam);

    const result = new oc.gp_Pnt(midPoint.X(), midPoint.Y(), midPoint.Z());

    curveAdaptor.delete();

    return result;
  }

  static getVertexPointRaw(vertex: TopoDS_Vertex): Point {
    const oc = getOC();
    const pnt = oc.BRep_Tool.Pnt(vertex);
    const result = new Point(pnt.X(), pnt.Y(), pnt.Z());
    pnt.delete();
    return result;
  }

  static getEdgeMidPointRaw(edge: TopoDS_Edge): Point {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const mid = adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2);
    const result = new Point(mid.X(), mid.Y(), mid.Z());
    mid.delete();
    adaptor.delete();
    return result;
  }

  static reverseEdgeRaw(edge: TopoDS_Edge): TopoDS_Edge {
    const oc = getOC();
    return oc.TopoDS.Edge(edge.Reversed());
  }

  static getEdgeOrientationRaw(edge: TopoDS_Edge): number {
    const oc = getOC();
    return edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  }

  static getEdgeTangentAtEndRaw(edge: TopoDS_Edge): Vector3d {
    const oc = getOC();
    const isReversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const curveHandle = oc.BRep_Tool.Curve(edge, 0, 1);
    const curve = curveHandle.get();
    const param = isReversed ? curve.FirstParameter() : curve.LastParameter();
    const edgeSign = isReversed ? -1 : 1;

    const tangentVec = new oc.gp_Vec();
    const pnt = new oc.gp_Pnt();
    curve.D1(param, pnt, tangentVec);
    const result = Convert.toVector3d(tangentVec, true).multiply(edgeSign);
    pnt.delete();

    return result;
  }

  static makeEdgeFromCurveAndVerticesRaw(curve: any, v1: TopoDS_Vertex, v2: TopoDS_Vertex): TopoDS_Edge {
    const oc = getOC();
    const handle = new oc.Handle_Geom_Curve(curve);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(handle, v1, v2);
    const edge = edgeMaker.Edge();
    edgeMaker.delete();
    handle.delete();
    return edge;
  }

  static splitEdges(edges: Edge[]): Edge[] {
    return EdgeOps.splitEdgesWithMapping(edges).edges;
  }

  static splitEdgesWithMapping(edges: Edge[]): {
    edges: Edge[];
    sourceIndex: number[];
  } {
    const oc = getOC();
    const tol = 1e-7;

    // Extract individual edges (expand wires passed at runtime)
    const allEdges: TopoDS_Edge[] = [];
    const inputIndex: number[] = []; // maps allEdges index → original edges[] index
    for (let ei = 0; ei < edges.length; ei++) {
      const shape = edges[ei].getShape();
      if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) {
        const wireEdges = Explorer.findShapes<TopoDS_Edge>(
          shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE
        );
        for (const we of wireEdges) {
          allEdges.push(we);
          inputIndex.push(ei);
        }
      } else {
        allEdges.push(shape as TopoDS_Edge);
        inputIndex.push(ei);
      }
    }

    // Gather split parameters for each edge via IntTools_EdgeEdge
    const splitParams: number[][] = allEdges.map(() => []);

    for (let i = 0; i < allEdges.length; i++) {
      for (let j = i + 1; j < allEdges.length; j++) {
        const tool = new oc.IntTools_EdgeEdge(allEdges[i], allEdges[j]);
        tool.Perform();

        if (tool.IsDone()) {
          const parts = tool.CommonParts();
          for (let k = 1; k <= parts.Length(); k++) {
            const cp = parts.Value(k);
            if (cp.Type() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
              splitParams[i].push(cp.VertexParameter1());
              splitParams[j].push(cp.VertexParameter2());
            }
          }
        }

        tool.delete();
      }
    }

    // Split each edge at its collected intersection parameters
    const result: Edge[] = [];
    const sourceIndex: number[] = [];
    for (let i = 0; i < allEdges.length; i++) {
      const edge = allEdges[i];
      const params = splitParams[i];
      const srcIdx = inputIndex[i];

      if (params.length === 0) {
        result.push(Edge.fromTopoDSEdge(edge));
        sourceIndex.push(srcIdx);
        continue;
      }

      const adaptor = new oc.BRepAdaptor_Curve(edge);
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const isClosed = adaptor.IsClosed();
      adaptor.delete();

      // Deduplicate and sort
      const sorted = [...params].sort((a, b) => a - b);
      const unique: number[] = [];
      for (const p of sorted) {
        if (unique.length === 0 || Math.abs(p - unique[unique.length - 1]) > tol) {
          unique.push(p);
        }
      }

      // For closed curves, deduplicate wrap-around (e.g. params near 0 and 2π are the same point)
      if (isClosed && unique.length >= 2) {
        const period = last - first;
        if (Math.abs(unique[unique.length - 1] - unique[0] - period) < tol) {
          unique.pop();
        }
      }

      // Filter out params at edge boundaries (skip for closed curves — their boundaries are the seam, not real endpoints)
      const interior = isClosed
        ? unique
        : unique.filter(p => p > first + tol && p < last - tol);

      if (interior.length === 0) {
        result.push(Edge.fromTopoDSEdge(edge));
        sourceIndex.push(srcIdx);
        continue;
      }

      // Get the underlying curve for creating sub-edges
      const curveHandle = oc.BRep_Tool.Curve(edge, 0, 1);
      const curve = curveHandle.get();
      const handle = new oc.Handle_Geom_Curve(curve);

      if (isClosed && interior.length >= 2) {
        // Closed curve: N split points → N arcs (no seam split)
        const period = last - first;
        for (let k = 0; k < interior.length; k++) {
          const u1 = interior[k];
          const u2 = k < interior.length - 1 ? interior[k + 1] : interior[0] + period;
          const maker = new oc.BRepBuilderAPI_MakeEdge(handle, u1, u2);
          if (maker.IsDone()) {
            result.push(Edge.fromTopoDSEdge(maker.Edge()));
            sourceIndex.push(srcIdx);
          }
          maker.delete();
        }
      } else if (!isClosed) {
        // Open curve: include edge endpoints as boundaries
        const allParams = [first, ...interior, last];
        for (let k = 0; k < allParams.length - 1; k++) {
          const maker = new oc.BRepBuilderAPI_MakeEdge(handle, allParams[k], allParams[k + 1]);
          if (maker.IsDone()) {
            result.push(Edge.fromTopoDSEdge(maker.Edge()));
            sourceIndex.push(srcIdx);
          }
          maker.delete();
        }
      } else {
        // Closed curve with < 2 split points: return as-is
        result.push(Edge.fromTopoDSEdge(edge));
        sourceIndex.push(srcIdx);
      }

      handle.delete();
    }

    return { edges: result, sourceIndex };
  }

  static findNearestEdgeIndex(edges: Edge[], point: Point, tolerance: number = -1): number {
    const indices = EdgeOps.findNearestEdgeIndices(edges, point, tolerance);
    return indices.length > 0 ? indices[0] : -1;
  }

  static findNearestEdgeIndices(edges: Edge[], point: Point, tolerance: number = -1): number[] {
    const oc = getOC();
    const DISTANCE_EPSILON = 1e-6;

    const gpPnt = new oc.gp_Pnt(point.x, point.y, point.z);
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(gpPnt);
    const vertexShape = vertexMaker.Shape();
    gpPnt.delete();

    let minDist = Infinity;
    const distances: number[] = [];

    const progress = new oc.Message_ProgressRange();
    for (let i = 0; i < edges.length; i++) {
      const distCalc = new oc.BRepExtrema_DistShapeShape(
        vertexShape,
        edges[i].getShape(),
        oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
        oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
        progress,
      );
      if (distCalc.IsDone()) {
        const d = distCalc.Value();
        distances[i] = d;
        if (d < minDist) {
          minDist = d;
        }
      } else {
        distances[i] = Infinity;
      }
      distCalc.delete();
    }
    progress.delete();
    vertexMaker.delete();

    if (tolerance >= 0 && minDist > tolerance) {
      return [];
    }

    const result: number[] = [];
    for (let i = 0; i < edges.length; i++) {
      if (distances[i] <= minDist + DISTANCE_EPSILON) {
        result.push(i);
      }
    }

    return result;
  }

  static isClosed(edge: Edge): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge.getShape() as TopoDS_Edge);
    const closed = adaptor.IsClosed();
    adaptor.delete();
    return closed;
  }
}
