import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Mesh } from "../mesh.js";
import type { MeasureDistanceValue, MeasureVec } from "./measure-types.js";
import type { ClassifiedEntity } from "./classify.js";

const MAX_FACE_SAMPLES = 400;
const EDGE_SAMPLES = 64;

function sampleFacePoints(shape: TopoDS_Shape): MeasureVec[] {
  const oc = getOC();
  const face = oc.TopoDS.Face(shape);
  Mesh.ensureTriangulated(face);

  const location = new oc.TopLoc_Location();
  const triangulation = oc.BRep_Tool.Triangulation(face, location, 0);
  if (triangulation.isNull()) {
    location.delete();
    return [];
  }

  const transform = location.Transformation();
  const nbNodes = triangulation.NbNodes();
  const stride = Math.max(1, Math.ceil(nbNodes / MAX_FACE_SAMPLES));
  const points: MeasureVec[] = [];

  for (let i = 1; i <= nbNodes; i += stride) {
    const node = triangulation.Node(i);
    const p = node.Transformed(transform);
    points.push({ x: p.X(), y: p.Y(), z: p.Z() });
    node.delete();
    p.delete();
  }

  transform.delete();
  triangulation.delete();
  location.delete();
  return points;
}

function sampleEdgePoints(shape: TopoDS_Shape): MeasureVec[] {
  const oc = getOC();
  const edge = oc.TopoDS.Edge(shape);
  const adaptor = new oc.BRepAdaptor_Curve(edge);
  const first = adaptor.FirstParameter();
  const last = adaptor.LastParameter();

  const points: MeasureVec[] = [];
  for (let i = 0; i <= EDGE_SAMPLES; i++) {
    const u = first + ((last - first) * i) / EDGE_SAMPLES;
    const p = adaptor.Value(u);
    points.push({ x: p.X(), y: p.Y(), z: p.Z() });
    p.delete();
  }

  adaptor.delete();
  return points;
}

export function sampleEntityPoints(entity: ClassifiedEntity): MeasureVec[] {
  const points = entity.kind === 'face' ? sampleFacePoints(entity.shape) : sampleEdgePoints(entity.shape);
  if (points.length === 0) {
    points.push(entity.anchor);
  }
  return points;
}

/**
 * Approximate maximum distance between two entities as the farthest pair of
 * sampled points (triangulation nodes / curve samples), so accuracy is bounded
 * by the mesh deflection.
 */
export function maxDistanceBetween(samplesA: MeasureVec[], samplesB: MeasureVec[]): MeasureDistanceValue {
  let best = -1;
  let from = samplesA[0];
  let to = samplesB[0];

  for (const a of samplesA) {
    for (const b of samplesB) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > best) {
        best = d2;
        from = a;
        to = b;
      }
    }
  }

  return { value: Math.sqrt(best), from, to };
}
