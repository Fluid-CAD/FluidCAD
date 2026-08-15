import type { TopoDS_Edge, TopoDS_Face } from "ocjs-fluidcad";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { AxisLike } from "../math/axis.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "./select.js";
import { LazyVertex } from "./lazy-vertex.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { buildOrthonormalFrame, computeFaceBoundingBoxCenter } from "./shape-anchor.js";
import { FaceOps } from "../oc/face-ops.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { getOC } from "../oc/init.js";

export type ConnectorOptions = {
  xDirection?: AxisLike;
};

export type ConnectorInput =
  | SelectSceneObject
  | LazySelectionSceneObject
  | LazyVertex
  | PlaneObjectBase;

export function frameFromSource(source: ConnectorInput, options: ConnectorOptions = {}): Plane {
  if (source instanceof PlaneObjectBase) {
    return frameFromPlane(source, options);
  }
  // Anchored vertices (`.center()` / `.start()` / `.offset(...)`) know their
  // underlying face/edge, so the frame Z follows that geometry instead of
  // defaulting to world Z like a plain lazy vertex.
  if (source instanceof AnchoredLazyVertex) {
    return source.getAnchorFrame(options);
  }
  if (source instanceof LazyVertex) {
    return frameFromVertexPoint(source.asPoint(), options);
  }
  if (source instanceof SelectSceneObject || source instanceof LazySelectionSceneObject) {
    return frameFromSelection(source, options);
  }
  throw new Error("connector(): unsupported source type — expected face/edge/vertex selection, LazyVertex, or plane.");
}

function frameFromSelection(
  selection: SelectSceneObject | LazySelectionSceneObject,
  options: ConnectorOptions,
): Plane {
  const shapes = selection.getShapes({ excludeMeta: false, excludeGuide: false });
  if (shapes.length === 0) {
    throw new Error("connector(): selection has no shapes.");
  }
  if (shapes.length > 1) {
    throw new Error("connector(): selection must resolve to exactly one face/edge/vertex.");
  }
  const shape = shapes[0];

  if (shape instanceof Face) {
    return frameFromFace(shape, options);
  }
  if (shape instanceof Edge) {
    return frameFromEdge(shape, options);
  }
  if (shape instanceof Vertex) {
    return frameFromVertexPoint(shape.toPoint(), options);
  }

  throw new Error(`connector(): unsupported selection shape "${shape.getType()}" — expected face, edge, or vertex.`);
}

function frameFromFace(face: Face, options: ConnectorOptions): Plane {
  const rawFace = face.getShape() as TopoDS_Face;
  const center = computeFaceBoundingBoxCenter(rawFace);
  const normal = FaceOps.calculateNormalRaw(rawFace).normalize();
  return buildOrthonormalFrame(center, normal, options);
}

function frameFromEdge(edge: Edge, options: ConnectorOptions): Plane {
  const rawEdge = edge.getShape() as TopoDS_Edge;
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(rawEdge);
  const curveType = adaptor.GetType();
  adaptor.delete();

  if (curveType === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const data = EdgeQuery.getCircleDataFromEdgeRaw(rawEdge);
    return buildOrthonormalFrame(data.center, data.axisDirection.normalize(), options);
  }

  if (curveType === oc.GeomAbs_CurveType.GeomAbs_Line) {
    // Origin at the edge midpoint, Z aligned with the edge tangent.
    const midpoint = EdgeOps.getEdgeMidPointRaw(rawEdge);
    const tangent = EdgeOps.getEdgeTangentAtEndRaw(rawEdge).normalize();
    return buildOrthonormalFrame(midpoint, tangent, options);
  }

  throw new Error("connector(): edge must be a line, circle, or arc.");
}

function frameFromVertexPoint(point: Point, options: ConnectorOptions): Plane {
  return buildOrthonormalFrame(point, Vector3d.unitZ(), options);
}

function frameFromPlane(planeObj: PlaneObjectBase, options: ConnectorOptions): Plane {
  const plane = planeObj.getPlane();
  if (!plane) {
    throw new Error("connector(): plane source has no plane state — was the plane built before the connector?");
  }
  if (options.xDirection !== undefined) {
    return buildOrthonormalFrame(plane.origin, plane.normal, options);
  }
  return new Plane(plane.origin, plane.xDirection, plane.normal);
}

export function isConnectorInput(value: unknown): value is ConnectorInput {
  return (
    value instanceof SelectSceneObject ||
    value instanceof LazySelectionSceneObject ||
    value instanceof LazyVertex ||
    value instanceof PlaneObjectBase
  );
}

export function connectorInputDependencies(source: ConnectorInput): SceneObject[] {
  return [source];
}
