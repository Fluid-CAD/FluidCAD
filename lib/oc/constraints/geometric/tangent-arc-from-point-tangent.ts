import { Edge } from "../../../common/edge.js";
import { QualifiedShape } from "../../../features/2d/constraints/qualified-geometry.js";
import { Plane } from "../../../math/plane.js";
import { Point2D } from "../../../math/point.js";
import { Geometry } from "../../geometry.js";
import { getOC } from "../../init.js";

const EPS = 1e-10;

interface LineTarget {
  pointOnLine: Point2D;
  direction: Point2D;
}

interface ArcCandidate {
  center: Point2D;
  radius: number;
  ccw: boolean;
  startPoint: Point2D;
  endPoint: Point2D;
  endAngle: number;
  endTangent: Point2D;
}

export function solveTangentArcFromPointTangent(
  plane: Plane,
  startPoint: Point2D,
  startTangent: Point2D,
  target: QualifiedShape,
  flip: boolean
): { edges: Edge[]; endTangent: Point2D | null } {
  const lineTarget = extractLineTarget(plane, target);

  const tlen = startTangent.length();
  if (tlen < EPS) {
    throw new Error('tArc(target): start tangent has zero magnitude');
  }
  const Tx = startTangent.x / tlen;
  const Ty = startTangent.y / tlen;
  const Nx = -Ty;
  const Ny = Tx;

  const Qx = lineTarget.pointOnLine.x;
  const Qy = lineTarget.pointOnLine.y;
  const dx = lineTarget.direction.x;
  const dy = lineTarget.direction.y;
  const nx = -dy;
  const ny = dx;
  const dPL = (startPoint.x - Qx) * nx + (startPoint.y - Qy) * ny;
  const k = Nx * nx + Ny * ny;

  // Two candidate signed radii from the line tangency equation:
  //   d_PL + r·k = s·r  ⇒  r = d_PL / (s − k)  for s ∈ {+1, −1}
  // Generically one yields r > 0 (center on the +N̂ side = "primary/left")
  // and the other yields r < 0 ("flipped/right"). Pick by sign so the
  // user-facing default is deterministic regardless of input geometry.
  const candidates: ArcCandidate[] = [];
  for (const s of [+1, -1]) {
    const denom = s - k;
    if (Math.abs(denom) < EPS) { continue; }
    const r = dPL / denom;
    if (Math.abs(r) < EPS) { continue; }
    candidates.push(buildCandidate(startPoint, Nx, Ny, r, lineTarget));
  }

  if (candidates.length === 0) {
    return { edges: [], endTangent: null };
  }

  const primary = candidates.find(c => c.ccw) ?? null;
  const flipped = candidates.find(c => !c.ccw) ?? null;
  let chosen: ArcCandidate;
  if (flip) {
    chosen = flipped ?? primary!;
  } else {
    chosen = primary ?? flipped!;
  }

  const edge = buildArcEdge(plane, chosen);
  return { edges: [edge], endTangent: chosen.endTangent };
}

function extractLineTarget(plane: Plane, target: QualifiedShape): LineTarget {
  const oc = getOC();
  const shape = target.shape;
  if (!(shape instanceof Edge)) {
    throw new Error('tArc(target): target must be a line edge');
  }
  const adaptor = new oc.BRepAdaptor_Curve(shape.getShape());
  const type = adaptor.GetType();
  if (type !== oc.GeomAbs_CurveType.GeomAbs_Line) {
    adaptor.delete();
    throw new Error('tArc(target): only line targets are supported');
  }
  adaptor.delete();

  const start = plane.worldToLocal(shape.getFirstVertex().toPoint());
  const end = plane.worldToLocal(shape.getLastVertex().toPoint());
  const diff = end.subtract(start);
  const len = diff.length();
  if (len < EPS) {
    throw new Error('tArc(target): target line has zero length');
  }
  return {
    pointOnLine: start,
    direction: diff.multiplyScalar(1 / len)
  };
}

function buildCandidate(
  P: Point2D,
  Nx: number, Ny: number,
  r: number,
  target: LineTarget
): ArcCandidate {
  const Ox = P.x + r * Nx;
  const Oy = P.y + r * Ny;
  const dx = target.direction.x;
  const dy = target.direction.y;
  const t = (Ox - target.pointOnLine.x) * dx + (Oy - target.pointOnLine.y) * dy;
  const Qx = target.pointOnLine.x + t * dx;
  const Qy = target.pointOnLine.y + t * dy;

  const radius = Math.abs(r);
  const ccw = r > 0;
  const endAngle = Math.atan2(Qy - Oy, Qx - Ox);

  const sign = ccw ? 1 : -1;
  const endTangent = new Point2D(
    sign * (-Math.sin(endAngle)),
    sign * Math.cos(endAngle)
  );

  return {
    center: new Point2D(Ox, Oy),
    radius,
    ccw,
    startPoint: P,
    endPoint: new Point2D(Qx, Qy),
    endAngle,
    endTangent
  };
}

function buildArcEdge(plane: Plane, c: ArcCandidate): Edge {
  const normal = c.ccw ? plane.normal : plane.normal.negate();
  const center = plane.localToWorld(c.center);
  const start = plane.localToWorld(c.startPoint);
  const end = plane.localToWorld(c.endPoint);
  const arc = Geometry.makeArc(center, c.radius, normal, start, end);
  return Geometry.makeEdgeFromCurve(arc);
}
