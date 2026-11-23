import type { LengthUnit } from "../../units/units.js";
import { MM_PER_UNIT } from "../../units/units.js";
import type { StandardPlane } from "../../math/plane.js";
import { BSplineCurve2D } from "./bspline.js";

// The 2D drawing model the DXF and SVG writers share. Pure TypeScript: no
// kernel, no document state — a drawing is plain data in the plane's own
// frame (X right, Y up, the plane's normal toward the viewer), in the
// document's unit, at model coordinates.

export type Vec2 = { x: number; y: number };

/**
 * One curve of a drawing. Direction carries no meaning in a drawing, so arcs
 * and ellipses are always stored counter-clockwise: `start` is in [0, 2π) and
 * `end` in (start, start + 2π]. A mirrored arc cannot be expressed, which is
 * what keeps both writers free of sense bugs.
 */
export type Curve2D =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; center: Vec2; radius: number }
  /** Angles in radians, counter-clockwise from `start` to `end`. */
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number }
  /**
   * DXF's ellipse model: `major` is the major semi-axis as a vector from the
   * centre, `ratio` minor/major (0 < ratio <= 1), and the point at parameter
   * `t` is `center + cos t · major + sin t · ratio · perp(major)`. Full when
   * `end - start` is 2π.
   */
  | { kind: 'ellipse'; center: Vec2; major: Vec2; ratio: number; start: number; end: number }
  /** A clamped, never periodic NURBS: `knots` is the flat knot vector, `weights` present when rational. */
  | { kind: 'bspline'; degree: number; knots: number[]; poles: Vec2[]; weights?: number[] }
  /** Only where a curve could not be converted; the drawing's warnings say so. */
  | { kind: 'polyline'; points: Vec2[]; closed: boolean };

/**
 * `visible`: sharp edges and silhouettes the viewer sees. `tangent`: smooth
 * (G1) edges between faces, on request. `hidden`: sharp edges and silhouettes
 * behind the model, on request.
 */
export type DrawingLayer = 'visible' | 'tangent' | 'hidden';

/** Layers from the one that wins an overlap to the one that yields. */
export const DRAWING_LAYERS: readonly DrawingLayer[] = ['visible', 'tangent', 'hidden'];

export type DrawingEntity = { layer: DrawingLayer; curve: Curve2D };

export type DrawingBounds = { min: Vec2; max: Vec2 };

export interface Drawing2D {
  /** The unit the numbers are in — the document's. */
  unit: LengthUnit;
  /** The standard plane the drawing is a view on, when it is one. */
  plane?: StandardPlane;
  /** Cleaned, chained and deterministically ordered — see `DrawingCleanup`. */
  entities: DrawingEntity[];
  /** Null for an empty drawing. */
  bounds: DrawingBounds | null;
  /** What the reader of the file should know: curves approximated by polylines, … */
  warnings: string[];
}

/**
 * How close two points of a drawing are to be one, in millimetres: the
 * coincidence, carrier-matching and zero-length tolerance of the whole
 * pipeline. Looser than the kernel's 1e-7 so the noise of its trimming never
 * splits a carrier, far tighter than anything drawn.
 */
export const DRAWING_TOLERANCE_MM = 1e-5;

const TWO_PI = 2 * Math.PI;

/** Geometry of single curves: evaluation, ends, bounds. */
export class Curves {
  /** `mm` millimetres in `unit` — the pure counterpart of `mmTol`, for code that knows its unit. */
  static tolerance(unit: LengthUnit, mm: number): number {
    return mm / MM_PER_UNIT[unit];
  }

  /** The point at `angle` on a circle or arc. */
  static circlePoint(center: Vec2, radius: number, angle: number): Vec2 {
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  }

  /** The point at parameter `t` on an ellipse. */
  static ellipsePoint(curve: Extract<Curve2D, { kind: 'ellipse' }>, t: number): Vec2 {
    const c = Math.cos(t);
    const s = Math.sin(t) * curve.ratio;
    return {
      x: curve.center.x + c * curve.major.x - s * curve.major.y,
      y: curve.center.y + c * curve.major.y + s * curve.major.x,
    };
  }

  /** `angle` brought into [0, 2π). */
  static normalizeAngle(angle: number): number {
    const a = angle % TWO_PI;
    return a < 0 ? a + TWO_PI : a;
  }

  /** Whether the curve closes on itself (a loop of its own). */
  static isClosed(curve: Curve2D, tolerance: number): boolean {
    switch (curve.kind) {
      case 'line':
        return false;
      case 'circle':
        return true;
      case 'arc':
        return false;
      case 'ellipse':
        return curve.end - curve.start >= TWO_PI - 1e-12; // unit: angular
      case 'polyline':
        return curve.closed;
      case 'bspline': {
        const [a, b] = Curves.endpoints(curve)!;
        return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
      }
    }
  }

  /** Start and end point; null for a circle (it has neither). A closed curve answers the same point twice. */
  static endpoints(curve: Curve2D): [Vec2, Vec2] | null {
    switch (curve.kind) {
      case 'line':
        return [curve.a, curve.b];
      case 'circle':
        return null;
      case 'arc':
        return [
          Curves.circlePoint(curve.center, curve.radius, curve.start),
          Curves.circlePoint(curve.center, curve.radius, curve.end),
        ];
      case 'ellipse':
        return [Curves.ellipsePoint(curve, curve.start), Curves.ellipsePoint(curve, curve.end)];
      case 'bspline': {
        const [t0, t1] = BSplineCurve2D.domain(curve);
        return [BSplineCurve2D.evaluate(curve, t0), BSplineCurve2D.evaluate(curve, t1)];
      }
      case 'polyline':
        return curve.closed
          ? [curve.points[0], curve.points[0]]
          : [curve.points[0], curve.points[curve.points.length - 1]];
    }
  }

  /**
   * `count + 1` points along the curve from start to end, evenly spaced in
   * its own parameter (per segment for a polyline). What bounds, signatures
   * and the tests' round-trip oracle are measured on.
   */
  static sample(curve: Curve2D, count: number): Vec2[] {
    const points: Vec2[] = [];
    const at = (i: number, from: number, to: number) => from + ((to - from) * i) / count;
    switch (curve.kind) {
      case 'line':
        for (let i = 0; i <= count; i++) {
          points.push({ x: at(i, curve.a.x, curve.b.x), y: at(i, curve.a.y, curve.b.y) });
        }
        return points;
      case 'circle':
        for (let i = 0; i <= count; i++) {
          points.push(Curves.circlePoint(curve.center, curve.radius, at(i, 0, TWO_PI)));
        }
        return points;
      case 'arc':
        for (let i = 0; i <= count; i++) {
          points.push(Curves.circlePoint(curve.center, curve.radius, at(i, curve.start, curve.end)));
        }
        return points;
      case 'ellipse':
        for (let i = 0; i <= count; i++) {
          points.push(Curves.ellipsePoint(curve, at(i, curve.start, curve.end)));
        }
        return points;
      case 'bspline': {
        const [t0, t1] = BSplineCurve2D.domain(curve);
        for (let i = 0; i <= count; i++) {
          points.push(BSplineCurve2D.evaluate(curve, at(i, t0, t1)));
        }
        return points;
      }
      case 'polyline': {
        const vertices = curve.closed ? [...curve.points, curve.points[0]] : curve.points;
        const perSegment = Math.max(1, Math.ceil(count / Math.max(1, vertices.length - 1)));
        for (let s = 0; s + 1 < vertices.length; s++) {
          for (let i = s === 0 ? 0 : 1; i <= perSegment; i++) {
            const f = i / perSegment;
            points.push({
              x: vertices[s].x + (vertices[s + 1].x - vertices[s].x) * f,
              y: vertices[s].y + (vertices[s + 1].y - vertices[s].y) * f,
            });
          }
        }
        return points;
      }
    }
  }

  /** Exact bounds for lines, circles, arcs and ellipses; a spline's are its sampled extent, never its looser control polygon. */
  static bounds(curve: Curve2D): DrawingBounds {
    const box = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
    const add = (p: Vec2) => {
      box.min.x = Math.min(box.min.x, p.x);
      box.min.y = Math.min(box.min.y, p.y);
      box.max.x = Math.max(box.max.x, p.x);
      box.max.y = Math.max(box.max.y, p.y);
    };
    switch (curve.kind) {
      case 'line':
        add(curve.a);
        add(curve.b);
        break;
      case 'circle':
        add({ x: curve.center.x - curve.radius, y: curve.center.y - curve.radius });
        add({ x: curve.center.x + curve.radius, y: curve.center.y + curve.radius });
        break;
      case 'arc': {
        add(Curves.circlePoint(curve.center, curve.radius, curve.start));
        add(Curves.circlePoint(curve.center, curve.radius, curve.end));
        // The axis extremes the arc passes through: multiples of π/2.
        for (let k = Math.ceil(curve.start / (Math.PI / 2)); k * (Math.PI / 2) <= curve.end; k++) {
          add(Curves.circlePoint(curve.center, curve.radius, k * (Math.PI / 2)));
        }
        break;
      }
      case 'ellipse': {
        add(Curves.ellipsePoint(curve, curve.start));
        add(Curves.ellipsePoint(curve, curve.end));
        // x(t) and y(t) are each A·cos(t − φ): extremes at φ + kπ.
        const phis = [
          Math.atan2(-curve.ratio * curve.major.y, curve.major.x),
          Math.atan2(curve.ratio * curve.major.x, curve.major.y),
        ];
        for (const phi of phis) {
          for (let k = Math.ceil((curve.start - phi) / Math.PI); phi + k * Math.PI <= curve.end; k++) {
            add(Curves.ellipsePoint(curve, phi + k * Math.PI));
          }
        }
        break;
      }
      case 'bspline':
        for (const p of Curves.sample(curve, Math.max(64, curve.poles.length * 8))) {
          add(p);
        }
        break;
      case 'polyline':
        for (const p of curve.points) {
          add(p);
        }
        break;
    }
    return box;
  }

  /** The bounds of every entity together; null when there is none. */
  static boundsOf(entities: readonly DrawingEntity[]): DrawingBounds | null {
    if (entities.length === 0) {
      return null;
    }
    const box = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
    for (const entity of entities) {
      const b = Curves.bounds(entity.curve);
      box.min.x = Math.min(box.min.x, b.min.x);
      box.min.y = Math.min(box.min.y, b.min.y);
      box.max.x = Math.max(box.max.x, b.max.x);
      box.max.y = Math.max(box.max.y, b.max.y);
    }
    return box;
  }
}
