import type { Face } from "../../common/face.js";
import type { Plane } from "../../math/plane.js";
import type { ResolvedHelixGeometry } from "../../math/helix-geometry.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";
import { getOC } from "../init.js";
import type { SpineAnalysis } from "./spine-analysis.js";

/** Locate once, align about the selected anchor, then transport back to the wire start. */
export function placeCylindricalProfile(
  spine: SpineAnalysis, helixIndex: number, geometry: ResolvedHelixGeometry,
  plane: Plane, faces: readonly Face[],
): { transform: Matrix4; station: Point } {
  const station = locateStation(spine, plane, faces);
  const helix = spine.edges[helixIndex];
  const { frame, winding, parameterEnd, zStart, zEnd } = geometry;
  const axial = (point: Point) => frame.origin.vectorTo(point).dot(frame.mainDirection);
  const parameter = (point: Point) => (axial(point) - zStart) / (zEnd - zStart) * parameterEnd;

  let tangent: Vector3d;
  if (station.index === helixIndex) {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(helix.edge);
    const pnt = new oc.gp_Pnt(), vec = new oc.gp_Vec();
    try {
      const u = Math.max(adaptor.FirstParameter(), Math.min(adaptor.LastParameter(), parameter(station.point)));
      adaptor.D1(u, pnt, vec);
      tangent = new Vector3d(vec.X(), vec.Y(), vec.Z()).normalize();
    } finally {
      pnt.delete(); vec.delete(); adaptor.delete();
    }
  } else {
    tangent = spine.edges[station.index].startTangent;
  }
  // Both normal signs describe the same section plane. Pick the closer sign
  // and rotate only once; a section already normal to ±tangent stays unchanged.
  const normal = plane.normal;
  const target = normal.dot(tangent) < 0 ? tangent.negate() : tangent;
  const cross = normal.cross(target);
  const align = cross.length() < 1e-10 ? Matrix4.identity()
    : Matrix4.fromRotationAroundAxis(station.point, cross.normalize(), Math.atan2(cross.length(), normal.dot(target)));

  let toStart: Matrix4;
  if (station.index < helixIndex) {
    toStart = Matrix4.fromTranslationVector(station.point.vectorTo(spine.startPoint));
  } else {
    const onHelix = station.index === helixIndex ? station.point : helix.end;
    const rotation = Matrix4.fromRotationAroundAxis(frame.origin, frame.mainDirection,
      winding * (parameter(helix.start) - parameter(onHelix)));
    const axialShift = Matrix4.fromTranslationVector(frame.mainDirection.multiply(axial(helix.start) - axial(onHelix)));
    const leadIn = Matrix4.fromTranslationVector(helix.start.vectorTo(spine.startPoint));
    const leadOut = Matrix4.fromTranslationVector(station.point.vectorTo(onHelix));
    toStart = leadIn.multiply(axialShift).multiply(rotation).multiply(leadOut);
  }
  return { transform: toStart.multiply(align), station: station.point };
}

/**
 * A plane(path, position) association wins. Otherwise localize the area
 * centroid of all profile regions by closest point on the actual wire.
 * Equally close, distinct stations are ambiguous and must not be guessed.
 */
function locateStation(spine: SpineAnalysis, plane: Plane, faces: readonly Face[]): { point: Point; index: number } {
  const oc = getOC();
  let anchor = plane.pathStation?.point;
  if (!anchor) {
    let x = 0, y = 0, z = 0, area = 0;
    for (const face of faces) {
      const props = new oc.GProp_GProps();
      try {
        oc.BRepGProp.SurfaceProperties(face.getShape(), props, false, false);
        const p = props.CentreOfMass(), weight = Math.abs(props.Mass());
        x += p.X() * weight; y += p.Y() * weight; z += p.Z() * weight; area += weight;
        p.delete();
      } finally { props.delete(); }
    }
    if (!(area > 0)) throw new Error("Sweep profile has no positive area for station localization.");
    anchor = new Point(x / area, y / area, z / area);
  }
  const pnt = new oc.gp_Pnt(anchor.x, anchor.y, anchor.z);
  const maker = new oc.BRepBuilderAPI_MakeVertex(pnt);
  const vertex = maker.Vertex();
  const progress = new oc.Message_ProgressRange();
  const candidates: { point: Point; index: number; distance: number }[] = [];
  try {
    spine.edges.forEach((edge, index) => {
      const distance = new oc.BRepExtrema_DistShapeShape(vertex, edge.edge,
        oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress);
      try {
        if (!distance.IsDone()) throw new Error("Sweep profile station localization failed.");
        for (let i = 1; i <= distance.NbSolution(); i++) {
          const p = distance.PointOnShape2(i);
          candidates.push({ point: new Point(p.X(), p.Y(), p.Z()), index, distance: distance.Value() });
          p.delete();
        }
      } finally { distance.delete(); }
    });
  } finally { progress.delete(); vertex.delete(); maker.delete(); pnt.delete(); }
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best || (plane.pathStation && best.distance > mmTol(1e-3))) {
    throw new Error("Sweep profile's authored station is not on this path.");
  }
  if (candidates.some(c => c.distance - best.distance <= mmTol(1e-6) && c.point.distanceTo(best.point) > mmTol(1e-3))) {
    throw new Error("Sweep profile has ambiguous stations on the path; use a profile on plane(path, position).");
  }
  return best;
}
