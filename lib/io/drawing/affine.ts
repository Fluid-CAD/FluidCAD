import type { Curve2D, Vec2 } from "./drawing.js";
import { Conic } from "./conic.js";

/**
 * An affine map of the plane: `x' = a·x + c·y + e`, `y' = b·x + d·y + f` —
 * the columns `(a, b)` and `(c, d)` are where the x and y unit vectors go,
 * `(e, f)` where the origin goes.
 */
export type Affine2 = { a: number; b: number; c: number; d: number; e: number; f: number };

/**
 * Affine maps of drawing curves. What a DXF block reference does to its
 * block (move, turn, scale each axis, mirror), what an entity drawn on a
 * flipped or tilted plane needs to land on the drawing plane, and what
 * placing an imported drawing in a sketch is.
 *
 * A circle or an arc under a map that is not a similarity is an ellipse, and
 * a mirror turns a counter-clockwise arc into a clockwise one; both go
 * through {@link Conic}, so what comes out is always a drawing curve in its
 * own convention (counter-clockwise, principal axes).
 */
export class Affine {
  static readonly IDENTITY: Affine2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  /** Scale about the origin, then a counter-clockwise turn by `angle` (radians) about it, then a move by `offset`. */
  static placement(scale: number, angle: number, offset: Vec2): Affine2 {
    const cos = Math.cos(angle) * scale;
    const sin = Math.sin(angle) * scale;
    return { a: cos, b: sin, c: -sin, d: cos, e: offset.x, f: offset.y };
  }

  static translation(offset: Vec2): Affine2 {
    return { a: 1, b: 0, c: 0, d: 1, e: offset.x, f: offset.y };
  }

  /** The map that applies `first`, then `second`. */
  static compose(first: Affine2, second: Affine2): Affine2 {
    return {
      a: second.a * first.a + second.c * first.b,
      b: second.b * first.a + second.d * first.b,
      c: second.a * first.c + second.c * first.d,
      d: second.b * first.c + second.d * first.d,
      e: second.a * first.e + second.c * first.f + second.e,
      f: second.b * first.e + second.d * first.f + second.f,
    };
  }

  static isIdentity(m: Affine2): boolean {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
  }

  static point(m: Affine2, p: Vec2): Vec2 {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  /** A direction or an offset: the map without its move. */
  static vector(m: Affine2, v: Vec2): Vec2 {
    return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
  }

  /**
   * The curve under the map, or null when the map flattens it to a point.
   * A conic flattened onto a line (a map of rank one) comes back as the
   * segment it covers. `tolerance` is a length in the mapped drawing.
   */
  static curve(m: Affine2, curve: Curve2D, tolerance: number): Curve2D | null {
    if (Affine.isIdentity(m)) {
      return curve;
    }
    switch (curve.kind) {
      case 'line':
        return { kind: 'line', a: Affine.point(m, curve.a), b: Affine.point(m, curve.b) };
      case 'circle':
        return Conic.fromConjugateDiameters(
          Affine.point(m, curve.center),
          Affine.vector(m, { x: curve.radius, y: 0 }),
          Affine.vector(m, { x: 0, y: curve.radius }),
          0, 2 * Math.PI, tolerance,
        );
      case 'arc':
        return Conic.fromConjugateDiameters(
          Affine.point(m, curve.center),
          Affine.vector(m, { x: curve.radius, y: 0 }),
          Affine.vector(m, { x: 0, y: curve.radius }),
          curve.start, curve.end, tolerance,
        );
      case 'ellipse':
        return Conic.fromConjugateDiameters(
          Affine.point(m, curve.center),
          Affine.vector(m, curve.major),
          Affine.vector(m, { x: -curve.major.y * curve.ratio, y: curve.major.x * curve.ratio }),
          curve.start, curve.end, tolerance,
        );
      case 'bspline':
        return {
          kind: 'bspline',
          degree: curve.degree,
          knots: curve.knots,
          poles: curve.poles.map((p) => Affine.point(m, p)),
          ...(curve.weights ? { weights: curve.weights } : {}),
        };
      case 'polyline':
        return { kind: 'polyline', points: curve.points.map((p) => Affine.point(m, p)), closed: curve.closed };
    }
  }
}
