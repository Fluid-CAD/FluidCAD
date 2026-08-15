import type { TopoDS_Edge, TopoDS_Face } from "ocjs-fluidcad";
import { getOC } from "../oc/init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { AxisLike, toAxis } from "../math/axis.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { FaceOps } from "../oc/face-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { Convert } from "../oc/convert.js";

export type EdgeAnchorOffsetMode = "relative" | "absolute";

/** A well-known point on a selected face or edge (`.center()`, `.start()`, …). */
export type VertexAnchorSpec =
  | { kind: "center" }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "offset"; mode: EdgeAnchorOffsetMode; value: number };

/** Anchor position plus the natural frame Z at that position. */
export type AnchorPlacement = { origin: Point; zDir: Vector3d };

export type FrameOptions = {
  xDirection?: AxisLike;
};

export function describeAnchor(spec: VertexAnchorSpec): string {
  return spec.kind === "offset" ? `offset('${spec.mode}', ${spec.value})` : `${spec.kind}()`;
}

/**
 * Resolve an anchor spec against a face or edge. The Z direction follows the
 * same conventions as connector frames: face → face normal, circle/arc edge
 * → circle axis, any other edge → tangent at the anchor point (oriented
 * start → end).
 */
export function anchorFromShape(shape: Shape, spec: VertexAnchorSpec): AnchorPlacement {
  if (shape instanceof Face) {
    return anchorFromFace(shape, spec);
  }
  if (shape instanceof Edge) {
    return anchorFromEdge(shape, spec);
  }
  throw new Error(`${describeAnchor(spec)}: selection must resolve to a face or an edge (got "${shape.getType()}").`);
}

function anchorFromFace(face: Face, spec: VertexAnchorSpec): AnchorPlacement {
  if (spec.kind !== "center") {
    throw new Error(`${describeAnchor(spec)} needs an edge selection — a face only supports center().`);
  }
  const raw = face.getShape() as TopoDS_Face;
  return {
    origin: computeFaceBoundingBoxCenter(raw),
    zDir: FaceOps.calculateNormalRaw(raw).normalize(),
  };
}

function anchorFromEdge(edge: Edge, spec: VertexAnchorSpec): AnchorPlacement {
  const oc = getOC();
  const raw = edge.getShape() as TopoDS_Edge;
  const adaptor = new oc.BRepAdaptor_Curve(raw);
  try {
    const curveType = adaptor.GetType();
    const isCircle = curveType === oc.GeomAbs_CurveType.GeomAbs_Circle;
    const isLine = curveType === oc.GeomAbs_CurveType.GeomAbs_Line;

    // center() of a circular edge (full circle or arc) is the circle center,
    // with the circle axis as Z — matching connector-on-edge frames.
    if (spec.kind === "center" && isCircle) {
      const data = EdgeQuery.getCircleDataFromEdgeRaw(raw);
      return { origin: data.center, zDir: data.axisDirection.normalize() };
    }

    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();

    // Point + curve-natural tangent at a parameter. The topological
    // orientation flag is deliberately ignored: the same physical edge
    // arrives FORWARD from one face's wire and REVERSED from its
    // neighbor's, depending on which selection path resolved it (a hover
    // pick explores the solid; `e.endEdges()` reads classified face
    // state) — an orientation-signed frame would flip Z between the
    // suggestion gizmo and the applied statement.
    const evalAt = (param: number): { point: Point; tangent: Vector3d } => {
      const pnt = new oc.gp_Pnt();
      const vec = new oc.gp_Vec();
      adaptor.D1(param, pnt, vec);
      const point = new Point(pnt.X(), pnt.Y(), pnt.Z());
      pnt.delete();
      return { point, tangent: Convert.toVector3d(vec, true) };
    };

    // Straight lines canonicalize geometrically — the direction leans
    // positive along the leading world axis — which also survives rebuilds
    // that reconstruct the underlying curve pointing the other way. Other
    // curves keep the curve's own parameterization (shared via the TShape,
    // so every selection path agrees).
    const flip = isLine && !isCanonicalLineDirection(evalAt(first).tangent.normalize());

    const fraction = anchorFraction(spec, isLine, last - first);
    const oriented = flip ? 1 - fraction : fraction;
    const param = first + oriented * (last - first);

    const { point: origin, tangent } = evalAt(param);

    if (isCircle) {
      const data = EdgeQuery.getCircleDataFromEdgeRaw(raw);
      return { origin, zDir: data.axisDirection.normalize() };
    }
    return { origin, zDir: tangent.multiply(flip ? -1 : 1).normalize() };
  } finally {
    adaptor.delete();
  }
}

const AXIS_EPS = 1e-7;

/**
 * The canonical direction for a straight edge: positive-leaning
 * lexicographically — X decides, then Y, then Z. Both `d` and `-d` describe
 * the same line; exactly one of them satisfies this rule.
 */
function isCanonicalLineDirection(d: Vector3d): boolean {
  if (Math.abs(d.x) > AXIS_EPS) {
    return d.x > 0;
  }
  if (Math.abs(d.y) > AXIS_EPS) {
    return d.y > 0;
  }
  return d.z >= 0;
}

/**
 * Turn an anchor spec into a 0..1 fraction along the oriented edge.
 * `curveSpan` is the parameter span; for line edges the parameterization is
 * arc length, so absolute distances convert directly.
 */
function anchorFraction(spec: VertexAnchorSpec, isLine: boolean, curveSpan: number): number {
  switch (spec.kind) {
    case "center":
      return 0.5;
    case "start":
      return 0;
    case "end":
      return 1;
    case "offset": {
      if (spec.mode === "relative") {
        if (spec.value < 0 || spec.value > 1) {
          throw new Error(`offset('relative', t): t must be between 0 (start) and 1 (end) — got ${spec.value}.`);
        }
        return spec.value;
      }
      if (!isLine) {
        throw new Error("offset('absolute', d) only works on straight line edges — use offset('relative', t) on curved edges.");
      }
      const length = curveSpan;
      const fraction = spec.value >= 0 ? spec.value / length : 1 + spec.value / length;
      if (fraction < 0 || fraction > 1) {
        throw new Error(
          `offset('absolute', ${spec.value}): distance exceeds the edge length (${round3(length)}).`,
        );
      }
      return fraction;
    }
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function anchorFrameFromShape(shape: Shape, spec: VertexAnchorSpec, options: FrameOptions = {}): Plane {
  const anchor = anchorFromShape(shape, spec);
  return buildOrthonormalFrame(anchor.origin, anchor.zDir, options);
}

export function buildOrthonormalFrame(origin: Point, normal: Vector3d, options: FrameOptions): Plane {
  const z = normal.normalize();

  let x: Vector3d;
  if (options.xDirection !== undefined) {
    const axis = toAxis(options.xDirection);
    x = orthogonalizeAgainst(axis.direction, z);
  } else {
    x = autoXFromZ(z);
  }

  return new Plane(origin, x, z);
}

function orthogonalizeAgainst(candidate: Vector3d, z: Vector3d): Vector3d {
  const c = candidate.normalize();
  const projected = c.subtract(z.multiply(c.dot(z)));
  if (projected.isZero(1e-9)) {
    throw new Error("xDirection is parallel to Z; cannot orthogonalize.");
  }
  return projected.normalize();
}

// Anchor the auto-frame to world up (+Z): project +Z onto the face plane
// to define Y, then derive X = Y × Z. This gives every non-horizontal face
// a "screen up" Y axis, so the X direction is the same predictable
// horizontal vector regardless of which sketch plane produced the face.
// The previous worldX-or-worldY fallback flipped at |Z·X| = 0.9, which
// made adjacent box faces use different reference axes.
function autoXFromZ(z: Vector3d): Vector3d {
  const worldUp = Vector3d.unitZ();
  // Horizontal face (top/bottom): worldUp lies along Z, so use +Y as the
  // in-plane "up" so the convention stays continuous with side faces.
  const upRef = Math.abs(z.dot(worldUp)) > 0.9 ? Vector3d.unitY() : worldUp;
  const y = upRef.subtract(z.multiply(upRef.dot(z))).normalize();
  return y.cross(z).normalize();
}

export function computeFaceBoundingBoxCenter(face: TopoDS_Face): Point {
  const oc = getOC();
  const bbox = new oc.Bnd_Box();
  oc.BRepBndLib.Add(face, bbox, true);
  const minPnt = bbox.CornerMin();
  const maxPnt = bbox.CornerMax();
  const result = new Point(
    (minPnt.X() + maxPnt.X()) / 2,
    (minPnt.Y() + maxPnt.Y()) / 2,
    (minPnt.Z() + maxPnt.Z()) / 2,
  );
  minPnt.delete();
  maxPnt.delete();
  bbox.delete();
  return result;
}
