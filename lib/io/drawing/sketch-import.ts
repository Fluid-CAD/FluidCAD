import type { Curve2D, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";
import { BSplineCurve2D } from "./bspline.js";
import { DrawingCleanup } from "./cleanup.js";

type BSpline = Extract<Curve2D, { kind: 'bspline' }>;
type Ellipse = Extract<Curve2D, { kind: 'ellipse' }>;

/**
 * One sketch statement an imported curve becomes, as plain geometry in
 * sketch coordinates — the arguments of `line(start, end)`,
 * `arc(start, end, center)` (counter-clockwise), `circle(center, diameter)`,
 * `ellipse(center, rx, ry, rotation)` (degrees) and `bezier(...points)`.
 */
export type SketchPrimitive =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; start: Vec2; end: Vec2; center: Vec2 }
  | { kind: 'circle'; center: Vec2; diameter: number }
  | { kind: 'ellipse'; center: Vec2; rx: number; ry: number; rotation: number }
  | { kind: 'bezier'; points: Vec2[] };

/** An end of a primitive that a join names: of a line or an arc, or a bezier's first or last point. */
export type SketchJoinEnd = { primitive: number; end: 'start' | 'end' };

/** Two ends that meet: what a `coincident` between them states. */
export type SketchJoin = { a: SketchJoinEnd; b: SketchJoinEnd };

/**
 * A point of a primitive a pin names: an end (of a line, an arc or a
 * bezier), the centre (of an arc, a circle or an ellipse), or a bezier's
 * control point by index.
 */
export type SketchPinPoint = { primitive: number; point: 'start' | 'end' | 'center' | number };

/**
 * One constraint that holds imported geometry where the file drew it:
 *
 * - `fix` — `fix(point)`: the point stays at the coordinates it is written with;
 * - `radius` — `radius(arc, value)`;
 * - `offset` — `distance(arc.start(), arc.center(), value, axis)`: how far
 *   the centre is from the arc's start along one sketch axis;
 * - `aligned` — `vertical(arc.start(), arc.center())` (the same x) or
 *   `horizontal(…)` (the same y): that offset when it is zero, said as the
 *   alignment it is instead of a dimension of nothing;
 * - `diameter` — `diameter(circle, value)`;
 * - `semi-radius` — `radius(ellipse, value, axis)`;
 * - `level` — `horizontal(ellipse)` / `vertical(ellipse)`: its RX axis along X or Y.
 */
export type SketchPin =
  | { kind: 'fix'; point: SketchPinPoint }
  | { kind: 'radius'; primitive: number; value: number }
  | { kind: 'offset'; primitive: number; axis: 'x' | 'y'; value: number }
  | { kind: 'aligned'; primitive: number; direction: 'horizontal' | 'vertical' }
  | { kind: 'diameter'; primitive: number; value: number }
  | { kind: 'semi-radius'; primitive: number; axis: 'x' | 'y'; value: number }
  | { kind: 'level'; primitive: number; direction: 'horizontal' | 'vertical' };

export interface SketchImportPlan {
  /** The statements to write, in the order of the curves they come from. */
  primitives: SketchPrimitive[];
  /** The ends that meet, each meeting point as a star from its first end. */
  joins: SketchJoin[];
  /** Curves left out because another curve of the import is the same one. */
  duplicates: number;
  /** Curves a sketch has no statement for (an elliptical arc, a rational or high-degree spline), written as cubic beziers within the tolerance. */
  approximated: number;
}

export interface SketchImportOptions {
  /** How close two points are to be one, in sketch units: what has no length, and how far an approximating bezier may stray. */
  tolerance: number;
  /** How close two ends must be for a join. At least `tolerance`. */
  joinTolerance: number;
  /** The decimals the statements are written with. Everything is rounded to them first, so joins and duplicates are judged on what is written. */
  decimals: number;
}

const TWO_PI = 2 * Math.PI;

/** How far the best cubic strays from a circular arc of angle θ, in radii per θ⁶. */
const CUBIC_ARC_ERROR = 1.8e-5;

/**
 * An arc's radius holds its bulge while its centre is at least this share of
 * the radius away from its chord: a sweep under about 157°, or over about
 * 203°. Nearer a half turn the radius changes too little with the bulge.
 */
const ARC_RADIUS_HOLDS = 0.2;

/** An elliptical arc is never cut into more pieces than this, whatever the tolerance asks. */
const MAX_ARC_PIECES = 64;

/**
 * Drawing curves → the sketch statements that draw them.
 *
 * A sketch has lines, arcs, circles, full ellipses and beziers, so that is
 * what the curves become. A B-spline is written as its own Bézier pieces,
 * one per knot span — exactly the same curve, whatever its degree up to
 * three. A rational spline, one of a higher degree and an elliptical arc
 * have no exact statement: they are fitted with cubics within the tolerance
 * first, and counted.
 *
 * The plan also lists where ends meet. A sketch does not join ends because
 * they share coordinates — a `coincident` does — so without the joins an
 * imported outline would come apart at the first drag.
 */
export class SketchImport {
  static plan(curves: readonly Curve2D[], options: SketchImportOptions): SketchImportPlan {
    const tolerance = options.tolerance;
    const joinTolerance = Math.max(options.joinTolerance, tolerance);
    const scale = 10 ** options.decimals;
    const round = (value: number) => {
      const rounded = Math.round(value * scale) / scale;
      return rounded === 0 ? 0 : rounded;
    };
    const point = (p: Vec2): Vec2 => ({ x: round(p.x), y: round(p.y) });

    const raw: SketchPrimitive[] = [];
    let approximated = 0;
    for (const source of curves) {
      const curve = DrawingCleanup.canonicalize(source, tolerance);
      if (!curve) {
        continue;
      }
      if (SketchImport.convert(curve, tolerance, raw)) {
        approximated++;
      }
    }

    const primitives: SketchPrimitive[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const primitive of raw) {
      const rounded = SketchImport.rounded(primitive, point, round);
      if (SketchImport.extent(rounded) <= joinTolerance) {
        continue;
      }
      const key = SketchImport.key(rounded);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      primitives.push(rounded);
    }

    return { primitives, joins: SketchImport.joins(primitives, joinTolerance), duplicates, approximated };
  }

  /**
   * The constraints that fix a plan's geometry in place, leaving it no
   * freedom — and none stated twice, which a solver reports as redundant.
   *
   * Every point is pinned once. With `joined` (the plan's joins are written
   * as coincidents) the ends at one meeting point are one point: the first
   * is fixed and the joins carry the others. Without, every end is fixed
   * on its own.
   *
   * What two fixed ends leave free is pinned by a size: a circle its centre
   * and diameter, an ellipse its centre and both semi-radii, a bezier its
   * inner control points. An arc between fixed ends can still bulge. Its
   * radius holds that — except for an arc near a half turn, whose centre
   * sits on its chord: there the radius is at its smallest and holds
   * nothing (the solver finds it both short of a degree of freedom and
   * redundant), so the centre is held by its distance from the arc's start
   * along the axis the chord runs across — or, when that distance is zero,
   * by being level with the start.
   *
   * One thing stays free: an ellipse turned off the sketch axes has no
   * constraint that holds its angle. `decimals` are the plan's.
   */
  static pins(plan: SketchImportPlan, options: { joined: boolean; decimals: number }): SketchPin[] {
    const scale = 10 ** options.decimals;
    const round = (value: number) => Math.round(value * scale) / scale;
    // An end a join attaches to another is carried by that join.
    const carried = new Set<string>();
    if (options.joined) {
      for (const join of plan.joins) {
        carried.add(`${join.b.primitive}:${join.b.end}`);
      }
    }
    const pins: SketchPin[] = [];
    const fixEnd = (primitive: number, end: 'start' | 'end') => {
      if (!carried.has(`${primitive}:${end}`)) {
        pins.push({ kind: 'fix', point: { primitive, point: end } });
      }
    };
    plan.primitives.forEach((primitive, index) => {
      switch (primitive.kind) {
        case 'line':
          fixEnd(index, 'start');
          fixEnd(index, 'end');
          break;
        case 'arc': {
          fixEnd(index, 'start');
          fixEnd(index, 'end');
          const radius = Math.hypot(primitive.start.x - primitive.center.x, primitive.start.y - primitive.center.y);
          const chord = { x: primitive.end.x - primitive.start.x, y: primitive.end.y - primitive.start.y };
          const middle = { x: (primitive.start.x + primitive.end.x) / 2, y: (primitive.start.y + primitive.end.y) / 2 };
          const rise = Math.hypot(primitive.center.x - middle.x, primitive.center.y - middle.y);
          if (rise >= radius * ARC_RADIUS_HOLDS) {
            pins.push({ kind: 'radius', primitive: index, value: round(radius) });
          } else {
            // The centre moves across the chord: measured along the axis nearest to that.
            const axis = Math.abs(chord.x) >= Math.abs(chord.y) ? 'y' : 'x';
            const value = round(Math.abs(primitive.center[axis] - primitive.start[axis]));
            if (value === 0) {
              // The same x is a vertical pair, the same y a horizontal one.
              pins.push({ kind: 'aligned', primitive: index, direction: axis === 'x' ? 'vertical' : 'horizontal' });
            } else {
              pins.push({ kind: 'offset', primitive: index, axis, value });
            }
          }
          break;
        }
        case 'circle':
          pins.push({ kind: 'fix', point: { primitive: index, point: 'center' } });
          pins.push({ kind: 'diameter', primitive: index, value: primitive.diameter });
          break;
        case 'ellipse':
          pins.push({ kind: 'fix', point: { primitive: index, point: 'center' } });
          pins.push({ kind: 'semi-radius', primitive: index, axis: 'x', value: primitive.rx });
          pins.push({ kind: 'semi-radius', primitive: index, axis: 'y', value: primitive.ry });
          if (primitive.rotation === 0) {
            pins.push({ kind: 'level', primitive: index, direction: 'horizontal' });
          } else if (Math.abs(primitive.rotation) === 90) {
            pins.push({ kind: 'level', primitive: index, direction: 'vertical' });
          }
          break;
        case 'bezier':
          fixEnd(index, 'start');
          for (let i = 1; i + 1 < primitive.points.length; i++) {
            pins.push({ kind: 'fix', point: { primitive: index, point: i } });
          }
          fixEnd(index, 'end');
          break;
      }
    });
    return pins;
  }

  /** The points a preview draws a primitive through. */
  static outline(primitive: SketchPrimitive): Vec2[] {
    switch (primitive.kind) {
      case 'line':
        return [primitive.start, primitive.end];
      case 'circle':
        return Curves.sample({ kind: 'circle', center: primitive.center, radius: primitive.diameter / 2 }, 72);
      case 'arc': {
        const radius = Math.hypot(primitive.start.x - primitive.center.x, primitive.start.y - primitive.center.y);
        const start = Math.atan2(primitive.start.y - primitive.center.y, primitive.start.x - primitive.center.x);
        let end = Math.atan2(primitive.end.y - primitive.center.y, primitive.end.x - primitive.center.x);
        if (end <= start) {
          end += TWO_PI;
        }
        const steps = Math.max(4, Math.ceil(((end - start) / TWO_PI) * 72));
        return Curves.sample({ kind: 'arc', center: primitive.center, radius, start, end }, steps);
      }
      case 'ellipse': {
        const angle = (primitive.rotation * Math.PI) / 180;
        return Curves.sample({
          kind: 'ellipse',
          center: primitive.center,
          major: { x: Math.cos(angle) * primitive.rx, y: Math.sin(angle) * primitive.rx },
          ratio: primitive.ry / primitive.rx,
          start: 0,
          end: TWO_PI,
        }, 72);
      }
      case 'bezier': {
        const steps = 12 * (primitive.points.length - 1);
        const points: Vec2[] = [];
        for (let i = 0; i <= steps; i++) {
          points.push(SketchImport.bezierPoint(primitive.points, i / steps));
        }
        return points;
      }
    }
  }

  // ─── Conversion ─────────────────────────────────────────────────────────

  /** Appends the statements of one curve; true when they approximate it. */
  private static convert(curve: Curve2D, tolerance: number, out: SketchPrimitive[]): boolean {
    switch (curve.kind) {
      case 'line':
        out.push({ kind: 'line', start: curve.a, end: curve.b });
        return false;
      case 'circle':
        out.push({ kind: 'circle', center: curve.center, diameter: curve.radius * 2 });
        return false;
      case 'arc':
        out.push({
          kind: 'arc',
          start: Curves.circlePoint(curve.center, curve.radius, curve.start),
          end: Curves.circlePoint(curve.center, curve.radius, curve.end),
          center: curve.center,
        });
        return false;
      case 'ellipse': {
        if (Curves.isClosed(curve, tolerance)) {
          const rx = Math.hypot(curve.major.x, curve.major.y);
          // The RX axis has no direction: its angle is kept in (−90°, 90°].
          let rotation = (Math.atan2(curve.major.y, curve.major.x) * 180) / Math.PI;
          // (The margin keeps a −90° that floating point left a hair short on the 90° side.)
          if (rotation > 90 + 1e-9) {
            rotation -= 180;
          } else if (rotation <= -90 + 1e-9) {
            rotation += 180;
          }
          out.push({ kind: 'ellipse', center: curve.center, rx, ry: rx * curve.ratio, rotation });
          return false;
        }
        for (const points of SketchImport.ellipseArc(curve, tolerance)) {
          out.push({ kind: 'bezier', points });
        }
        return true;
      }
      case 'bspline': {
        const exact = curve.degree <= 3 && !curve.weights;
        SketchImport.beziers(exact ? curve : BSplineCurve2D.toCubic(curve, tolerance), out);
        return !exact;
      }
      case 'polyline': {
        const points = curve.closed ? [...curve.points, curve.points[0]] : curve.points;
        for (let i = 0; i + 1 < points.length; i++) {
          out.push({ kind: 'line', start: points[i], end: points[i + 1] });
        }
        return false;
      }
    }
  }

  /** A non-rational spline as its Bézier pieces: a line for a straight piece, a bezier for the others. */
  private static beziers(curve: BSpline, out: SketchPrimitive[]): void {
    for (const points of BSplineCurve2D.bezierSegments(curve)) {
      if (points.length === 2) {
        out.push({ kind: 'line', start: points[0], end: points[1] });
      } else {
        out.push({ kind: 'bezier', points });
      }
    }
  }

  /**
   * An elliptical arc as cubic Béziers no farther than `tolerance` from it.
   *
   * The arc is the image of a circular arc, and the cubic that best follows
   * a circular arc of angle θ is known: its two inner poles sit on the end
   * tangents, 4/3 · tan(θ/4) radii from the ends. It strays from the circle
   * by about 1.8e-5 · θ⁶ radii (2.7e-4 at a quarter turn), so the number of
   * equal pieces that keeps the error under the tolerance follows from the
   * arc's angle and its long radius — a handful, where a fit that compares
   * the two curves at equal parameters would take dozens.
   */
  private static ellipseArc(curve: Ellipse, tolerance: number): Vec2[][] {
    const sweep = curve.end - curve.start;
    const radius = Math.hypot(curve.major.x, curve.major.y);
    const needed = sweep * Math.pow((radius * CUBIC_ARC_ERROR) / tolerance, 1 / 6);
    const pieces = Math.min(MAX_ARC_PIECES, Math.max(Math.ceil(sweep / (Math.PI / 2) - 1e-9), Math.ceil(needed)));
    const step = sweep / pieces;
    const reach = (4 / 3) * Math.tan(step / 4);
    // The ellipse's own frame: `c` along the major axis, `s` along the minor.
    const at = (c: number, s: number): Vec2 => ({
      x: curve.center.x + c * curve.major.x - s * curve.ratio * curve.major.y,
      y: curve.center.y + c * curve.major.y + s * curve.ratio * curve.major.x,
    });
    const segments: Vec2[][] = [];
    for (let i = 0; i < pieces; i++) {
      const t0 = curve.start + i * step;
      const t1 = t0 + step;
      const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
      segments.push([
        at(c0, s0),
        at(c0 - reach * s0, s0 + reach * c0),
        at(c1 + reach * s1, s1 - reach * c1),
        at(c1, s1),
      ]);
    }
    return segments;
  }

  private static bezierPoint(points: readonly Vec2[], t: number): Vec2 {
    const work = points.map((p) => ({ x: p.x, y: p.y }));
    for (let level = work.length - 1; level > 0; level--) {
      for (let i = 0; i < level; i++) {
        work[i].x += (work[i + 1].x - work[i].x) * t;
        work[i].y += (work[i + 1].y - work[i].y) * t;
      }
    }
    return work[0];
  }

  // ─── Rounding, duplicates ───────────────────────────────────────────────

  private static rounded(primitive: SketchPrimitive, point: (p: Vec2) => Vec2, round: (v: number) => number): SketchPrimitive {
    switch (primitive.kind) {
      case 'line':
        return { kind: 'line', start: point(primitive.start), end: point(primitive.end) };
      case 'arc':
        return { kind: 'arc', start: point(primitive.start), end: point(primitive.end), center: point(primitive.center) };
      case 'circle':
        return { kind: 'circle', center: point(primitive.center), diameter: round(primitive.diameter) };
      case 'ellipse':
        return {
          kind: 'ellipse',
          center: point(primitive.center),
          rx: round(primitive.rx),
          ry: round(primitive.ry),
          rotation: round(primitive.rotation),
        };
      case 'bezier':
        return { kind: 'bezier', points: primitive.points.map(point) };
    }
  }

  /** How far the primitive reaches: under the join tolerance it is a speck, not a curve. */
  private static extent(primitive: SketchPrimitive): number {
    const far = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
    switch (primitive.kind) {
      case 'line':
        return far(primitive.start, primitive.end);
      case 'arc': {
        // Its length along the curve: an arc's ends may be close while it goes most of the way round.
        const from = Math.atan2(primitive.start.y - primitive.center.y, primitive.start.x - primitive.center.x);
        const to = Math.atan2(primitive.end.y - primitive.center.y, primitive.end.x - primitive.center.x);
        const sweep = ((to - from) % TWO_PI + TWO_PI) % TWO_PI;
        return sweep * far(primitive.start, primitive.center);
      }
      case 'circle':
        return primitive.diameter;
      case 'ellipse':
        return Math.min(primitive.rx, primitive.ry) * 2;
      case 'bezier': {
        let reach = 0;
        for (const p of primitive.points) {
          reach = Math.max(reach, far(primitive.points[0], p));
        }
        return reach;
      }
    }
  }

  /** The same key for the same curve, whichever way a line or a bezier is drawn. */
  private static key(primitive: SketchPrimitive): string {
    const p = (v: Vec2) => `${v.x},${v.y}`;
    const either = (forward: string, backward: string) => (forward < backward ? forward : backward);
    switch (primitive.kind) {
      case 'line':
        return `l|${either(`${p(primitive.start)}|${p(primitive.end)}`, `${p(primitive.end)}|${p(primitive.start)}`)}`;
      case 'arc':
        return `a|${p(primitive.start)}|${p(primitive.end)}|${p(primitive.center)}`;
      case 'circle':
        return `c|${p(primitive.center)}|${primitive.diameter}`;
      case 'ellipse':
        return `e|${p(primitive.center)}|${primitive.rx}|${primitive.ry}|${primitive.rotation}`;
      case 'bezier': {
        const forward = primitive.points.map(p).join('|');
        const backward = [...primitive.points].reverse().map(p).join('|');
        return `b|${either(forward, backward)}`;
      }
    }
  }

  // ─── Joins ──────────────────────────────────────────────────────────────

  /**
   * The ends that sit within `tolerance` of each other, grouped (an end near
   * an end near a third is one meeting point) and each group written as a
   * star from its first end. Two ends of one line or arc never join: that
   * would fold the curve onto a point. A bezier that closes on itself does.
   */
  private static joins(primitives: readonly SketchPrimitive[], tolerance: number): SketchJoin[] {
    type End = SketchJoinEnd & { at: Vec2 };
    const ends: End[] = [];
    primitives.forEach((primitive, index) => {
      if (primitive.kind === 'line' || primitive.kind === 'arc') {
        ends.push({ primitive: index, end: 'start', at: primitive.start }, { primitive: index, end: 'end', at: primitive.end });
      } else if (primitive.kind === 'bezier') {
        ends.push(
          { primitive: index, end: 'start', at: primitive.points[0] },
          { primitive: index, end: 'end', at: primitive.points[primitive.points.length - 1] },
        );
      }
    });

    const parent = ends.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    // A grid of cells one tolerance wide: an end's neighbours are in its cell or the eight around it.
    const cells = new Map<string, number[]>();
    const cellOf = (v: number) => Math.floor(v / tolerance);
    ends.forEach((end, i) => {
      const cx = cellOf(end.at.x);
      const cy = cellOf(end.at.y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (Math.hypot(ends[j].at.x - end.at.x, ends[j].at.y - end.at.y) <= tolerance) {
              const a = find(i);
              const b = find(j);
              if (a !== b) {
                parent[Math.max(a, b)] = Math.min(a, b);
              }
            }
          }
        }
      }
      const key = `${cx},${cy}`;
      const cell = cells.get(key);
      if (cell) {
        cell.push(i);
      } else {
        cells.set(key, [i]);
      }
    });

    const groups = new Map<number, number[]>();
    ends.forEach((_, i) => {
      const root = find(i);
      const group = groups.get(root);
      if (group) {
        group.push(i);
      } else {
        groups.set(root, [i]);
      }
    });

    const joins: SketchJoin[] = [];
    for (const group of groups.values()) {
      const first = ends[group[0]];
      const firstFolds = primitives[first.primitive].kind !== 'bezier';
      for (const index of group.slice(1)) {
        const other = ends[index];
        if (other.primitive === first.primitive && firstFolds) {
          continue;
        }
        joins.push({
          a: { primitive: first.primitive, end: first.end },
          b: { primitive: other.primitive, end: other.end },
        });
      }
    }
    return joins;
  }
}
