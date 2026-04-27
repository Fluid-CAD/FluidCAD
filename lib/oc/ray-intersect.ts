import type { TopoDS_Edge, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Geometry } from "./geometry.js";
import { Explorer } from "./explorer.js";
import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";

const PROBE_HALF_LENGTH = 1e6;
const ON_TARGET_EPSILON = 1e-7;

/**
 * Finds the nearest intersection of an oriented "ray" with a target geometry's
 * edges, returning the result in sketch-local 2D coordinates.
 *
 * The ray is modelled as a long bounded segment centered on `start` along
 * `direction`, so hits on either side of `start` are considered. The nearest
 * hit (by absolute signed distance) is returned. Hits that coincide with
 * `start` (within tolerance) are skipped so a start point already on the
 * target is not picked.
 *
 * Throws if the target produces no usable edge hits.
 */
export function findNearestRayIntersection(
  plane: Plane,
  start: Point2D,
  direction: Point2D,
  target: SceneObject
): Point2D {
  const oc = getOC();

  const dirLen = Math.hypot(direction.x, direction.y);
  if (dirLen < 1e-12) {
    throw new Error("findNearestRayIntersection: direction vector is zero");
  }
  const dir = new Point2D(direction.x / dirLen, direction.y / dirLen);

  const probeStart2d = new Point2D(
    start.x - dir.x * PROBE_HALF_LENGTH,
    start.y - dir.y * PROBE_HALF_LENGTH
  );
  const probeEnd2d = new Point2D(
    start.x + dir.x * PROBE_HALF_LENGTH,
    start.y + dir.y * PROBE_HALF_LENGTH
  );

  const probeStartWorld = plane.localToWorld(probeStart2d);
  const probeEndWorld = plane.localToWorld(probeEnd2d);

  const probeCurve = Geometry.makeSegment(probeStartWorld, probeEndWorld);
  const probeEdge = Geometry.makeEdgeRaw(probeCurve);

  const targetEdges: TopoDS_Edge[] = [];
  for (const shape of target.getShapes({ excludeGuide: false })) {
    const inner = shape.getShape() as TopoDS_Shape;
    if (inner.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
      targetEdges.push(inner as TopoDS_Edge);
    } else {
      const edges = Explorer.findShapes<TopoDS_Edge>(inner, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      for (const edge of edges) {
        targetEdges.push(edge);
      }
    }
  }

  if (targetEdges.length === 0) {
    probeEdge.delete();
    throw new Error("Target geometry has no edges to intersect with");
  }

  // Probe edge is parameterized 0..2L by arc-length (GC_MakeSegment), with the
  // start at param 0. Recover the world point at a given param via the curve
  // adaptor, then convert to plane-local 2D.
  const probeAdaptor = new oc.BRepAdaptor_Curve(probeEdge);

  let bestHit: Point2D | null = null;
  let bestSignedDist = Infinity;

  for (const targetEdge of targetEdges) {
    const tool = new oc.IntTools_EdgeEdge(probeEdge, targetEdge);
    tool.Perform();

    if (!tool.IsDone()) {
      tool.delete();
      continue;
    }

    const parts = tool.CommonParts();
    const partCount = parts.Length();

    for (let i = 1; i <= partCount; i++) {
      const cp = parts.Value(i);
      if (cp.Type() !== oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
        continue;
      }

      const probeParam = cp.VertexParameter1();
      const gpHit = probeAdaptor.Value(probeParam);
      const hitWorld = new Point(gpHit.X(), gpHit.Y(), gpHit.Z());
      gpHit.delete();

      const hit2d = plane.worldToLocal(hitWorld);
      const signedDist = (hit2d.x - start.x) * dir.x + (hit2d.y - start.y) * dir.y;
      if (Math.abs(signedDist) < ON_TARGET_EPSILON) {
        continue;
      }

      if (Math.abs(signedDist) < Math.abs(bestSignedDist)) {
        bestSignedDist = signedDist;
        bestHit = hit2d;
      }
    }

    tool.delete();
  }

  probeAdaptor.delete();
  probeEdge.delete();

  if (!bestHit) {
    throw new Error("Line does not intersect target geometry");
  }

  return bestHit;
}
