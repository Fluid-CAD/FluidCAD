import type { gp_Pnt, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Explorer } from "../explorer.js";
import { CurveClassifier } from "../curve-classifier.js";
import { SurfaceClass, SurfaceClassifier } from "../surface-classifier.js";
import { FaceOps } from "../face-ops.js";
import type { MeasureEntityKind, MeasureVec } from "./measure-types.js";
import { dist, dot, projectPointOnLine, scale } from "./vec.js";
import { mmTol } from "../../units/tolerance.js";

export type FaceForm = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'surface';
export type EdgeForm = 'line' | 'circle' | 'arc' | 'ellipse' | 'curve';

/** What a `surface` or `curve` form is, in the classifiers' words: the kind no measure form names. */
export type FreeKind = 'revolved' | 'extruded' | 'freeform' | 'spline' | 'other';

/**
 * Geometric summary of a selected face or edge, in plain JS values so all the
 * pair math (angles, parallel distances, projections) runs without further
 * OCCT calls.
 */
export interface ClassifiedEntity {
  kind: MeasureEntityKind;
  form: FaceForm | EdgeForm;
  /**
   * Unit direction characterizing the entity, or null when it has none. A
   * planar face's normal points out of its solid (see {@link classifyFace});
   * every other direction keeps its geometry's own sign.
   */
  dir: MeasureVec | null;
  /**
   * How `dir` relates to the entity: a 'normal' is perpendicular to the entity
   * (plane normal, circle-plane normal, torus axis), an 'axis' runs along it
   * (line direction, cylinder/cone axis). Two entities lie parallel when
   * normal∥normal, axis∥axis, or normal⊥axis.
   */
  dirKind: 'normal' | 'axis' | null;
  /** A point on the entity's defining element (plane location, axis location). */
  point: MeasureVec | null;
  /**
   * The entity's center, else null: circle/arc/ellipse center, sphere/torus
   * center, a cylinder's centroid projected onto its axis, and for a planar
   * face bounded by one circle (a disc or annulus) that circle's center — so
   * a pin's barrel and a bore's end face measure center to center.
   */
  center: MeasureVec | null;
  /** Representative point on the entity (face area centroid, edge midpoint) used to anchor measurement lines. */
  anchor: MeasureVec;
  radius?: number;
  area?: number;
  length?: number;
  /** For a `surface` or `curve` form: the classifier's kind. */
  freeKind?: FreeKind;
  shape: TopoDS_Shape;
}

function vecFromPnt(p: gp_Pnt): MeasureVec {
  const v = { x: p.X(), y: p.Y(), z: p.Z() };
  p.delete();
  return v;
}

function vecFromPoint(p: { x: number; y: number; z: number }): MeasureVec {
  return { x: p.x, y: p.y, z: p.z };
}

// Relative part of the circular-boundary match; the absolute floor is 1 mm
// read in the active unit.
const CARRIER_FIT_TOL = 1e-6;

/**
 * The circle bounding a planar face when its outer wire is one circle — a
 * single closed edge or several arcs sharing center and radius (a revolve
 * seam or boolean splits a disc's rim without changing what it bounds).
 */
function detectCircularBoundary(face: TopoDS_Face): { center: MeasureVec; radius: number } | null {
  const oc = getOC();
  const outerWire = oc.BRepTools.OuterWire(face);
  const edges = Explorer.findShapes(outerWire, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  outerWire.delete();

  let found: { center: MeasureVec; radius: number } | null = null;
  let consistent = true;
  for (const edgeShape of edges) {
    if (!consistent) {
      edgeShape.delete();
      continue;
    }
    // Native circles, and the B-splines a loft's round ends are made of.
    const curve = CurveClassifier.classifyRaw(edgeShape);
    const rim = (curve.kind === 'circle' || curve.kind === 'arc') && curve.center && curve.radius !== undefined
      ? { center: vecFromPoint(curve.center), radius: curve.radius }
      : null;
    edgeShape.delete();
    if (!rim) {
      consistent = false;
    } else if (!found) {
      found = rim;
    } else {
      const tol = CARRIER_FIT_TOL * (mmTol(1) + rim.radius);
      consistent = dist(rim.center, found.center) <= tol && Math.abs(rim.radius - found.radius) <= tol;
    }
  }
  return consistent ? found : null;
}

/**
 * A face's form, carrier and size, read off its {@link SurfaceClassifier}
 * class — so a flat B-spline measures as the plane `face().planar()` admits.
 * A planar face's normal is its OUTWARD normal: the carrier plane's axis
 * (native or recovered) carries whatever sign the surface was built with,
 * so it is signed by
 * {@link FaceOps.outwardNormalRaw} — which reads the face's orientation, so
 * `shape` must be the face as its solid's explorer gives it.
 *
 * `surface` is the face's class when the caller already holds it — a
 * wrapper's kept class, or its {@link SurfaceClassifier.forBuilding} class
 * for a reader that builds on what it measures.
 */
export function classifyFace(shape: TopoDS_Shape, surface: SurfaceClass = SurfaceClassifier.classifyRaw(shape)): ClassifiedEntity {
  const oc = getOC();
  const face = oc.TopoDS.Face(shape);

  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  const area = props.Mass();
  const anchor = vecFromPnt(props.CentreOfMass());
  props.delete();

  const result: ClassifiedEntity = {
    kind: 'face',
    form: 'surface',
    dir: null,
    dirKind: null,
    point: null,
    center: null,
    anchor,
    area,
    shape,
  };

  if (surface.kind === 'plane' && surface.origin && surface.normal) {
    result.form = 'plane';
    result.point = vecFromPoint(surface.origin);
    result.dir = vecFromPoint(surface.normal);
    result.dirKind = 'normal';
    const rim = detectCircularBoundary(face);
    if (rim) {
      result.center = rim.center;
      result.radius = rim.radius;
    }
  } else if (surface.kind === 'cylinder' && surface.axis) {
    const point = vecFromPoint(surface.axis.origin);
    const dir = vecFromPoint(surface.axis.direction);
    result.radius = surface.radius;
    result.form = 'cylinder';
    result.point = point;
    result.center = projectPointOnLine(anchor, point, dir);
    result.dir = dir;
    result.dirKind = 'axis';
  } else if (surface.kind === 'cone' && surface.axis) {
    result.form = 'cone';
    result.point = vecFromPoint(surface.axis.origin);
    result.dir = vecFromPoint(surface.axis.direction);
    result.dirKind = 'axis';
  } else if (surface.kind === 'sphere' && surface.center) {
    const center = vecFromPoint(surface.center);
    result.radius = surface.radius;
    result.form = 'sphere';
    result.point = center;
    result.center = center;
  } else if (surface.kind === 'torus' && surface.axis) {
    const point = vecFromPoint(surface.axis.origin);
    result.form = 'torus';
    result.point = point;
    result.center = point;
    result.dir = vecFromPoint(surface.axis.direction);
    result.dirKind = 'normal';
  }

  if (result.form === 'surface' && !SurfaceClassifier.isAnalytic(surface.kind)) {
    result.freeKind = surface.kind as FreeKind;
  }

  if (result.form === 'plane' && result.dir) {
    const outward = FaceOps.outwardNormalRaw(face);
    if (outward && dot(result.dir, outward) < 0) {
      result.dir = scale(result.dir, -1);
    }
  }
  // The typed cast is a fresh handle of its own; the result keeps the caller's raw `shape`.
  face.delete();
  return result;
}

/**
 * An edge's form, carrier and size, read off its {@link CurveClassifier}
 * class — so a straight or circular B-spline measures as the line or circle
 * the edge filters admit.
 */
export function classifyEdge(shape: TopoDS_Shape): ClassifiedEntity {
  const oc = getOC();
  const edge = oc.TopoDS.Edge(shape);

  const props = new oc.GProp_GProps();
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const length = props.Mass();
  props.delete();

  const adaptor = new oc.BRepAdaptor_Curve(edge);
  const first = adaptor.FirstParameter();
  const last = adaptor.LastParameter();
  const anchor = vecFromPnt(adaptor.Value((first + last) / 2));

  const result: ClassifiedEntity = {
    kind: 'edge',
    form: 'curve',
    dir: null,
    dirKind: null,
    point: null,
    center: null,
    anchor,
    length,
    shape,
  };

  const curve = CurveClassifier.classifyRaw(edge);
  if (curve.kind === 'line' && curve.origin && curve.direction) {
    result.form = 'line';
    result.point = vecFromPoint(curve.origin);
    result.dir = vecFromPoint(curve.direction);
    result.dirKind = 'axis';
  } else if ((curve.kind === 'circle' || curve.kind === 'arc' || curve.kind === 'ellipse') && curve.center && curve.axisDirection) {
    // A B-spline standing for a circle or an arc of one measures like the
    // circle it was sketched as: the rim of a loft's round end.
    const center = vecFromPoint(curve.center);
    result.form = curve.kind;
    if (curve.kind !== 'ellipse') {
      result.radius = curve.radius;
    }
    result.point = center;
    result.center = center;
    result.dir = vecFromPoint(curve.axisDirection);
    result.dirKind = 'normal';
  }

  if (result.form === 'curve' && (curve.kind === 'spline' || curve.kind === 'other')) {
    result.freeKind = curve.kind;
  }

  adaptor.delete();
  // The typed cast is a fresh handle of its own; the result keeps the caller's raw `shape`.
  edge.delete();
  return result;
}
