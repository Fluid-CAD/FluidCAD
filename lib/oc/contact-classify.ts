import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { FaceQuery } from "./face-query.js";
import { classifyEdge, classifyFace } from "./measure/classify.js";
import type { MeasureVec } from "./measure/measure-types.js";
import { cross, dot, len, scale, sub } from "./measure/vec.js";

export type ContactForm = 'plane' | 'cylinder' | 'sphere' | 'cone' | 'line' | 'circle';

/**
 * Canonical-parametrization extents of a contact entity, used by the solver
 * to keep the analytic (infinite) surface bounded to the physical face:
 * - plane:    u along `xDir`, v along `dir × xDir`, both from `point` (mm)
 * - cylinder: u = angle (rad) about `dir` from `xDir`, v = axial mm from `point`
 * - cone:     u = angle (rad) about `dir` from `xDir`, v = axial mm from the apex
 * - line:     u = mm along `dir` from `point` (v unused)
 * - circle:   u = angle (rad) about `dir` from `xDir` around the center (v unused)
 * An angular interval spanning ≥ 2π means the full revolution (seam faces).
 */
export type ContactBounds = { uMin: number; uMax: number; vMin?: number; vMax?: number };

/**
 * Plain-JS canonical contact geometry in PART-LOCAL frame — everything the
 * browser-side solver needs to evaluate tangency residuals without OCCT.
 * World placement comes from the body pose at solve time (same convention
 * as connector frames).
 */
export type ContactEntity = {
  form: ContactForm;
  /** Plane point / axis point / sphere-circle center / cone APEX. */
  point: [number, number, number];
  /** Plane outward normal / axis direction / circle-plane normal (unit). */
  dir: [number, number, number];
  /**
   * Reference direction the angular/planar bounds are measured from
   * (unit, ⊥ `dir`). Arbitrary but fixed — bounds only make sense in the
   * frame they were computed in. Absent for spheres.
   */
  xDir?: [number, number, number];
  radius?: number;               // cylinder, sphere, circle
  halfAngleDeg?: number;         // cone
  /** Material side: shaft/boss = true, bore/pocket = false. Meaningless for planes/edges (true). */
  convex: boolean;
  bounds?: ContactBounds;
};

// Sampling densities must keep the periodic-direction spacing (2π/steps)
// safely below FULL_CIRCLE_GAP, or a seam face's uniform samples read as a
// partial revolution.
const FACE_GRID_STEPS = 16;
const EDGE_SAMPLE_STEPS = 32;
/** Angular gap below which sampled angles are treated as covering the full revolution. */
const FULL_CIRCLE_GAP = 0.45; // rad, ~26°
const TWO_PI = Math.PI * 2;

function toTuple(v: MeasureVec): [number, number, number] {
  return [v.x, v.y, v.z];
}

/** Deterministic unit vector perpendicular to `dir`. */
function perpendicular(dir: MeasureVec): MeasureVec {
  const seed: MeasureVec = Math.abs(dir.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const p = cross(dir, seed);
  return scale(p, 1 / len(p));
}

/**
 * Face point + OUTWARD normal at UV mid (orientation-corrected) — the
 * probe-together pattern (`calculateNormal` alone is planar-only).
 */
function probeFaceOutward(shape: TopoDS_Shape): { point: MeasureVec; normal: MeasureVec } | null {
  const oc = getOC();
  const rawFace = oc.TopoDS.Face(shape);
  const bounds = oc.BRepTools.UVBounds(rawFace);
  const u = (bounds.UMin + bounds.UMax) / 2;
  const v = (bounds.VMin + bounds.VMax) / 2;

  const surface = oc.BRep_Tool.Surface(rawFace);
  const props = new oc.GeomLProp_SLProps(surface, u, v, 1, 1e-6);
  try {
    let rawNormal = props.Normal();
    if (rawFace.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
      rawNormal = rawNormal.Reversed();
    }
    const normal = { x: rawNormal.X(), y: rawNormal.Y(), z: rawNormal.Z() };
    const value = props.Value();
    const point = { x: value.X(), y: value.Y(), z: value.Z() };
    return { point, normal };
  } catch {
    return null;
  } finally {
    props.delete();
    surface.delete();
  }
}

/** Surface points on the face's UV bounding box (restricted adaptor). */
function sampleFacePoints(shape: TopoDS_Shape): MeasureVec[] {
  const oc = getOC();
  const face = oc.TopoDS.Face(shape);
  const adaptor = new oc.BRepAdaptor_Surface(face, true);
  const points: MeasureVec[] = [];
  try {
    const u1 = adaptor.FirstUParameter();
    const u2 = adaptor.LastUParameter();
    const v1 = adaptor.FirstVParameter();
    const v2 = adaptor.LastVParameter();
    if (!isFinite(u1) || !isFinite(u2) || !isFinite(v1) || !isFinite(v2)) {
      return points;
    }
    for (let i = 0; i <= FACE_GRID_STEPS; i++) {
      for (let j = 0; j <= FACE_GRID_STEPS; j++) {
        const p = adaptor.Value(
          u1 + ((u2 - u1) * i) / FACE_GRID_STEPS,
          v1 + ((v2 - v1) * j) / FACE_GRID_STEPS,
        );
        points.push({ x: p.X(), y: p.Y(), z: p.Z() });
        p.delete();
      }
    }
  } finally {
    adaptor.delete();
  }
  return points;
}

function sampleEdgePoints(shape: TopoDS_Shape): MeasureVec[] {
  const oc = getOC();
  const edge = oc.TopoDS.Edge(shape);
  const adaptor = new oc.BRepAdaptor_Curve(edge);
  const points: MeasureVec[] = [];
  try {
    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();
    if (!isFinite(first) || !isFinite(last)) {
      return points;
    }
    for (let i = 0; i <= EDGE_SAMPLE_STEPS; i++) {
      const p = adaptor.Value(first + ((last - first) * i) / EDGE_SAMPLE_STEPS);
      points.push({ x: p.X(), y: p.Y(), z: p.Z() });
      p.delete();
    }
  } finally {
    adaptor.delete();
  }
  return points;
}

/**
 * Minimal covering interval of a set of angles (rad). Sorts, finds the
 * largest gap around the circle, and returns the complement; a gap smaller
 * than FULL_CIRCLE_GAP collapses to the full revolution.
 */
function angularInterval(angles: number[]): { uMin: number; uMax: number } {
  if (angles.length === 0) {
    return { uMin: -Math.PI, uMax: Math.PI };
  }
  const sorted = angles
    .map(a => ((a % TWO_PI) + TWO_PI) % TWO_PI)
    .sort((x, y) => x - y);
  let largestGap = sorted[0] + TWO_PI - sorted[sorted.length - 1];
  let gapEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      gapEnd = sorted[i];
    }
  }
  if (largestGap < FULL_CIRCLE_GAP) {
    return { uMin: -Math.PI, uMax: Math.PI };
  }
  return { uMin: gapEnd, uMax: gapEnd + (TWO_PI - largestGap) };
}

function planarBounds(point: MeasureVec, xDir: MeasureVec, yDir: MeasureVec, samples: MeasureVec[]): ContactBounds | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const s of samples) {
    const rel = sub(s, point);
    const u = dot(rel, xDir);
    const v = dot(rel, yDir);
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }
  return { uMin, uMax, vMin, vMax };
}

function axialBounds(
  point: MeasureVec, dir: MeasureVec, xDir: MeasureVec, yDir: MeasureVec, samples: MeasureVec[],
): ContactBounds | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const angles: number[] = [];
  let vMin = Infinity, vMax = -Infinity;
  for (const s of samples) {
    const rel = sub(s, point);
    const axial = dot(rel, dir);
    vMin = Math.min(vMin, axial); vMax = Math.max(vMax, axial);
    const radial = sub(rel, scale(dir, axial));
    if (len(radial) < 1e-9) {
      continue; // apex / on-axis sample carries no angle
    }
    angles.push(Math.atan2(dot(radial, yDir), dot(radial, xDir)));
  }
  const { uMin, uMax } = angularInterval(angles);
  return { uMin, uMax, vMin, vMax };
}

function lineBounds(point: MeasureVec, dir: MeasureVec, samples: MeasureVec[]): ContactBounds | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  let uMin = Infinity, uMax = -Infinity;
  for (const s of samples) {
    const u = dot(sub(s, point), dir);
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
  }
  return { uMin, uMax };
}

function circleBounds(center: MeasureVec, dir: MeasureVec, xDir: MeasureVec, yDir: MeasureVec, samples: MeasureVec[]): ContactBounds | undefined {
  const angles: number[] = [];
  for (const s of samples) {
    const rel = sub(s, center);
    const inPlane = sub(rel, scale(dir, dot(rel, dir)));
    if (len(inPlane) < 1e-9) {
      continue;
    }
    angles.push(Math.atan2(dot(inPlane, yDir), dot(inPlane, xDir)));
  }
  if (angles.length === 0) {
    return undefined;
  }
  return angularInterval(angles);
}

function classifyContactFace(shape: Shape): ContactEntity | null {
  const raw = shape.getShape();
  const classified = classifyFace(raw);

  if (classified.form === 'plane') {
    const point = classified.point!;
    const dir = classified.dir!;
    // The classify axis normal is the SURFACE normal — re-orient it to the
    // face's outward (material-out) side so the sign policy (§ contact side
    // is canonical) holds without a flip option.
    const probe = probeFaceOutward(raw);
    const outward = probe && dot(probe.normal, dir) < 0 ? scale(dir, -1) : dir;
    const xDir = perpendicular(outward);
    const yDir = cross(outward, xDir);
    return {
      form: 'plane',
      point: toTuple(point),
      dir: toTuple(outward),
      xDir: toTuple(xDir),
      convex: true,
      bounds: planarBounds(point, xDir, yDir, sampleFacePoints(raw)),
    };
  }

  if (classified.form === 'cylinder' || classified.form === 'sphere' || classified.form === 'cone') {
    const probe = probeFaceOutward(raw);
    if (!probe) {
      return null;
    }

    if (classified.form === 'sphere') {
      const center = classified.center!;
      const radial = sub(probe.point, center);
      return {
        form: 'sphere',
        point: toTuple(center),
        dir: [0, 0, 1],
        radius: classified.radius,
        convex: dot(probe.normal, radial) > 0,
      };
    }

    if (classified.form === 'cylinder') {
      const point = classified.point!;
      const dir = classified.dir!;
      const rel = sub(probe.point, point);
      const radial = sub(rel, scale(dir, dot(rel, dir)));
      const xDir = perpendicular(dir);
      const yDir = cross(dir, xDir);
      return {
        form: 'cylinder',
        point: toTuple(point),
        dir: toTuple(dir),
        xDir: toTuple(xDir),
        radius: classified.radius,
        convex: dot(probe.normal, radial) > 0,
        bounds: axialBounds(point, dir, xDir, yDir, sampleFacePoints(raw)),
      };
    }

    // Cone: canonical form is the APEX plus the axis pointing toward the
    // widening side, half-angle always positive.
    const cone = FaceQuery.getSurfaceAdaptorConeRaw(raw);
    const apexPnt = cone.Apex();
    const apex = { x: apexPnt.X(), y: apexPnt.Y(), z: apexPnt.Z() };
    apexPnt.delete();
    const axis = cone.Axis();
    const axisDir = axis.Direction();
    let dir = { x: axisDir.X(), y: axisDir.Y(), z: axisDir.Z() };
    axisDir.delete();
    axis.delete();
    const semiAngle = cone.SemiAngle();
    cone.delete();
    if (semiAngle < 0) {
      dir = scale(dir, -1);
    }
    const rel = sub(probe.point, apex);
    const radial = sub(rel, scale(dir, dot(rel, dir)));
    const xDir = perpendicular(dir);
    const yDir = cross(dir, xDir);
    return {
      form: 'cone',
      point: toTuple(apex),
      dir: toTuple(dir),
      xDir: toTuple(xDir),
      halfAngleDeg: Math.abs(semiAngle) * (180 / Math.PI),
      convex: len(radial) > 1e-9 ? dot(probe.normal, radial) > 0 : true,
      bounds: axialBounds(apex, dir, xDir, yDir, sampleFacePoints(raw)),
    };
  }

  return null; // torus / freeform 'surface' — unsupported (Tier 2)
}

function classifyContactEdge(shape: Shape): ContactEntity | null {
  const raw = shape.getShape();
  const classified = classifyEdge(raw);

  if (classified.form === 'line') {
    const point = classified.point!;
    const dir = classified.dir!;
    return {
      form: 'line',
      point: toTuple(point),
      dir: toTuple(dir),
      convex: true,
      bounds: lineBounds(point, dir, sampleEdgePoints(raw)),
    };
  }

  if (classified.form === 'circle' || classified.form === 'arc') {
    const center = classified.center!;
    const dir = classified.dir!;
    const xDir = perpendicular(dir);
    const yDir = cross(dir, xDir);
    return {
      form: 'circle',
      point: toTuple(center),
      dir: toTuple(dir),
      xDir: toTuple(xDir),
      radius: classified.radius,
      convex: true,
      bounds: circleBounds(center, dir, xDir, yDir, sampleEdgePoints(raw)),
    };
  }

  return null; // ellipse / freeform 'curve' — unsupported (Tier 2)
}

/**
 * Classify one picked/exposed face or edge into canonical contact geometry.
 * Returns null for unsupported forms (torus, freeform surfaces/curves,
 * ellipses) — callers surface that as a pointed record-build error.
 */
export function classifyContactShape(shape: Shape): ContactEntity | null {
  if (shape instanceof Face) {
    return classifyContactFace(shape);
  }
  if (shape instanceof Edge) {
    return classifyContactEdge(shape);
  }
  return null;
}

