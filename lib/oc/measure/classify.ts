import type { BRepAdaptor_Curve, BRepAdaptor_Surface, gp_Ax1, gp_Dir, gp_Pnt, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import type { MeasureEntityKind, MeasureVec } from "./measure-types.js";
import { cross, dot, len, scale, sub } from "./vec.js";

export type FaceForm = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'surface';
export type EdgeForm = 'line' | 'circle' | 'arc' | 'ellipse' | 'curve';

/**
 * Geometric summary of a selected face or edge, in plain JS values so all the
 * pair math (angles, parallel distances, projections) runs without further
 * OCCT calls.
 */
export interface ClassifiedEntity {
  kind: MeasureEntityKind;
  form: FaceForm | EdgeForm;
  /** Unit direction characterizing the entity, or null when it has none. */
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
  /** True geometric center (circle/arc/ellipse/sphere/torus), else null. */
  center: MeasureVec | null;
  /** Representative point on the entity (face area centroid, edge midpoint) used to anchor measurement lines. */
  anchor: MeasureVec;
  radius?: number;
  area?: number;
  length?: number;
  shape: TopoDS_Shape;
}

function vecFromPnt(p: gp_Pnt): MeasureVec {
  const v = { x: p.X(), y: p.Y(), z: p.Z() };
  p.delete();
  return v;
}

function vecFromDir(d: gp_Dir): MeasureVec {
  const v = { x: d.X(), y: d.Y(), z: d.Z() };
  d.delete();
  return v;
}

function axisData(axis: gp_Ax1): { point: MeasureVec; dir: MeasureVec } {
  const data = { point: vecFromPnt(axis.Location()), dir: vecFromDir(axis.Direction()) };
  axis.delete();
  return data;
}

// Booleans, text outlines, wraps and lofts often carry geometrically planar
// faces / straight edges on fitted B-spline (or extruded-curve) geometry, so
// the adaptor type alone misses them. These sampling fallbacks recover the
// carrier plane/line numerically. (OCCT's GeomLib_IsPlanarSurface would do the
// face check natively but is not in the current ocjs binding.)
const CARRIER_FIT_TOL = 1e-6;
const PLANAR_GRID_STEPS = 5;
const STRAIGHT_EDGE_STEPS = 8;

function detectPlanarSurface(adaptor: BRepAdaptor_Surface): { point: MeasureVec; dir: MeasureVec } | null {
  const u1 = adaptor.FirstUParameter();
  const u2 = adaptor.LastUParameter();
  const v1 = adaptor.FirstVParameter();
  const v2 = adaptor.LastVParameter();
  if (!isFinite(u1) || !isFinite(u2) || !isFinite(v1) || !isFinite(v2)) {
    return null;
  }

  const points: MeasureVec[] = [];
  for (let i = 0; i <= PLANAR_GRID_STEPS; i++) {
    for (let j = 0; j <= PLANAR_GRID_STEPS; j++) {
      const p = adaptor.Value(u1 + ((u2 - u1) * i) / PLANAR_GRID_STEPS, v1 + ((v2 - v1) * j) / PLANAR_GRID_STEPS);
      points.push({ x: p.X(), y: p.Y(), z: p.Z() });
      p.delete();
    }
  }

  const origin = points[0];
  let span = points[0];
  let spanDist = 0;
  for (const p of points) {
    const d = len(sub(p, origin));
    if (d > spanDist) {
      spanDist = d;
      span = p;
    }
  }
  if (spanDist < CARRIER_FIT_TOL) {
    return null;
  }

  const e1 = scale(sub(span, origin), 1 / spanDist);
  let normal: MeasureVec | null = null;
  let normalLen = 0;
  for (const p of points) {
    const n = cross(e1, sub(p, origin));
    const nLen = len(n);
    if (nLen > normalLen) {
      normalLen = nLen;
      normal = n;
    }
  }
  if (!normal || normalLen < CARRIER_FIT_TOL * spanDist) {
    return null;
  }

  const dir = scale(normal, 1 / normalLen);
  const tol = CARRIER_FIT_TOL * (1 + spanDist);
  for (const p of points) {
    if (Math.abs(dot(sub(p, origin), dir)) > tol) {
      return null;
    }
  }
  return { point: origin, dir };
}

function detectStraightCurve(
  adaptor: BRepAdaptor_Curve,
  first: number,
  last: number,
): { point: MeasureVec; dir: MeasureVec } | null {
  const points: MeasureVec[] = [];
  for (let i = 0; i <= STRAIGHT_EDGE_STEPS; i++) {
    const p = adaptor.Value(first + ((last - first) * i) / STRAIGHT_EDGE_STEPS);
    points.push({ x: p.X(), y: p.Y(), z: p.Z() });
    p.delete();
  }

  const chord = sub(points[points.length - 1], points[0]);
  const chordLen = len(chord);
  if (chordLen < CARRIER_FIT_TOL) {
    return null;
  }

  const dir = scale(chord, 1 / chordLen);
  const tol = CARRIER_FIT_TOL * (1 + chordLen);
  for (const p of points) {
    if (len(cross(sub(p, points[0]), dir)) > tol) {
      return null;
    }
  }
  return { point: points[0], dir };
}

export function classifyFace(shape: TopoDS_Shape): ClassifiedEntity {
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

  const adaptor = new oc.BRepAdaptor_Surface(face, true);
  const type = adaptor.GetType();

  if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
    const plane = adaptor.Plane();
    const { point, dir } = axisData(plane.Axis());
    plane.delete();
    result.form = 'plane';
    result.point = point;
    result.dir = dir;
    result.dirKind = 'normal';
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const cylinder = adaptor.Cylinder();
    const { point, dir } = axisData(cylinder.Axis());
    result.radius = cylinder.Radius();
    cylinder.delete();
    result.form = 'cylinder';
    result.point = point;
    result.dir = dir;
    result.dirKind = 'axis';
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
    const cone = adaptor.Cone();
    const { point, dir } = axisData(cone.Axis());
    cone.delete();
    result.form = 'cone';
    result.point = point;
    result.dir = dir;
    result.dirKind = 'axis';
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
    const sphere = adaptor.Sphere();
    const center = vecFromPnt(sphere.Location());
    result.radius = sphere.Radius();
    sphere.delete();
    result.form = 'sphere';
    result.point = center;
    result.center = center;
  } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
    const torus = adaptor.Torus();
    const { point, dir } = axisData(torus.Axis());
    torus.delete();
    result.form = 'torus';
    result.point = point;
    result.center = point;
    result.dir = dir;
    result.dirKind = 'normal';
  } else {
    const planar = detectPlanarSurface(adaptor);
    if (planar) {
      result.form = 'plane';
      result.point = planar.point;
      result.dir = planar.dir;
      result.dirKind = 'normal';
    }
  }

  adaptor.delete();
  return result;
}

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

  const type = adaptor.GetType();

  if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
    const line = adaptor.Line();
    const point = vecFromPnt(line.Location());
    const dir = vecFromDir(line.Direction());
    line.delete();
    result.form = 'line';
    result.point = point;
    result.dir = dir;
    result.dirKind = 'axis';
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const circle = adaptor.Circle();
    const center = vecFromPnt(circle.Location());
    const { dir } = axisData(circle.Axis());
    result.radius = circle.Radius();
    circle.delete();
    result.form = adaptor.IsClosed() ? 'circle' : 'arc';
    result.point = center;
    result.center = center;
    result.dir = dir;
    result.dirKind = 'normal';
  } else if (type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
    const ellipse = adaptor.Ellipse();
    const center = vecFromPnt(ellipse.Location());
    const { dir } = axisData(ellipse.Axis());
    ellipse.delete();
    result.form = 'ellipse';
    result.point = center;
    result.center = center;
    result.dir = dir;
    result.dirKind = 'normal';
  } else {
    const straight = detectStraightCurve(adaptor, first, last);
    if (straight) {
      result.form = 'line';
      result.point = straight.point;
      result.dir = straight.dir;
      result.dirKind = 'axis';
    }
  }

  adaptor.delete();
  return result;
}
