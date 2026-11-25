import type { Curve2D, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";
import { BSplineCurve2D } from "./bspline.js";
import { DrawingCleanup } from "./cleanup.js";
import type { CutLine } from "./construction-lines.js";
import { ImportedTexts, type ResolvedText } from "./imported-text.js";
import { SketchEllipticalArcs, type SketchEllipticalArc } from "./sketch-elliptical-arc.js";

type BSpline = Extract<Curve2D, { kind: 'bspline' }>;

/**
 * One sketch statement an imported curve becomes, as plain geometry in
 * sketch coordinates — the arguments of `line(start, end)`,
 * `arc(start, end, center)` (counter-clockwise), `circle(center, diameter)`,
 * `ellipse(center, rx, ry, rotation)` (degrees),
 * `eArc(start, end, center, rx, ry, rotation)` (counter-clockwise, degrees),
 * `bezier(...points)` and, for a point of the file, `point(at)`. A line marked `guide` is a
 * construction line: written `line(start, end).guide()`. A text is the
 * sketch's own `text(…)` (see {@link SketchTextPrimitive}).
 */
export type SketchPrimitive =
  | { kind: 'line'; start: Vec2; end: Vec2; guide?: true }
  | { kind: 'arc'; start: Vec2; end: Vec2; center: Vec2 }
  | { kind: 'circle'; center: Vec2; diameter: number }
  | { kind: 'ellipse'; center: Vec2; rx: number; ry: number; rotation: number }
  | SketchEllipticalArc
  | { kind: 'bezier'; points: Vec2[] }
  | { kind: 'point'; at: Vec2 }
  | SketchTextPrimitive;

/**
 * A text statement: `text(text).font(font).size(size)…`. A sketch text has
 * no angle of its own. One that reads level is placed by its anchor —
 * `.at(at)`, where its first baseline starts, is centred or ends, by
 * `align`. One that is turned follows a line: `path` is the primitive it is
 * written along — a guide line on its baseline, `text(text, line)` — which
 * starts at the text's own start for `left`, is centred on its middle for
 * `center`, and ends at its end for `right`.
 */
export type SketchTextPrimitive = {
  kind: 'text';
  text: string;
  font: string;
  bold: boolean;
  italic: boolean;
  /** The em size. */
  size: number;
  align: 'left' | 'center' | 'right';
  /** A multiple of the font's own line height. */
  lineSpacing: number;
  letterSpacing: number;
} & ({ at: Vec2; path?: undefined } | { path: number; at?: undefined });

/** A primitive that is drawn geometry: every one but a text. */
export type SketchDrawnPrimitive = Exclude<SketchPrimitive, { kind: 'text' }>;
type DrawnPrimitive = SketchDrawnPrimitive;

/** An end of a primitive that a join names: of a line, an arc or an elliptical arc, a bezier's first or last point, or a point primitive itself (`'point'`). */
export type SketchJoinEnd = { primitive: number; end: 'start' | 'end' | 'point' };

/** Two ends that meet: what a `coincident` between them states. */
export type SketchJoin = { a: SketchJoinEnd; b: SketchJoinEnd };

/**
 * A point of a primitive a pin names: an end (of a line, an arc, an
 * elliptical arc or a bezier), the centre (of an arc, a circle, an ellipse
 * or an elliptical arc), a bezier's control point by index, a point primitive itself (`'point'`), or the
 * anchor of a text placed by one (`'anchor'`).
 */
export type SketchPinPoint = { primitive: number; point: 'start' | 'end' | 'center' | 'point' | 'anchor' | number };

/**
 * One constraint that holds imported geometry where the file drew it:
 *
 * - `fix` — `fix(point)`: the point stays at the coordinates it is written with;
 * - `radius` — `radius(arc, value)`;
 * - `offset` — `distance(arc.start(), arc.center(), value, axis)`: how far
 *   the centre is from the start of the arc, or of the elliptical arc,
 *   along one sketch axis;
 * - `aligned` — `vertical(arc.start(), arc.center())` (the same x) or
 *   `horizontal(…)` (the same y): that offset when it is zero, said as the
 *   alignment it is instead of a dimension of nothing;
 * - `diameter` — `diameter(circle, value)`;
 * - `semi-radius` — `radius(ellipse, value, axis)`, of an ellipse or an elliptical arc;
 * - `level` — `horizontal(ellipse)` / `vertical(ellipse)`: the RX axis of an
 *   ellipse or an elliptical arc along X or Y.
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
  /**
   * The statements to write: the curves' in the order of the curves they
   * come from, then the points', the guide lines', the baselines of the
   * texts that are turned, and last the texts — so every primitive before
   * the first text is geometry, and a text's `path` names one of them.
   */
  primitives: SketchPrimitive[];
  /** The ends that meet — a point on an end is one of them — each meeting point as a star from its first end. */
  joins: SketchJoin[];
  /** Curves left out because another curve of the import is the same one. */
  duplicates: number;
  /** Curves a sketch has no statement for (a rational or high-degree spline), written as cubic beziers within the tolerance. */
  approximated: number;
}

export interface SketchImportOptions {
  /** How close two points are to be one, in sketch units: what has no length, and how far an approximating bezier may stray. */
  tolerance: number;
  /** How close two ends must be for a join. At least `tolerance`. */
  joinTolerance: number;
  /**
   * The decimals the statements are written with. Everything is rounded to
   * them first, so joins and duplicates are judged on what is written. (Two
   * numbers of an elliptical arc are written with a few more: see
   * `SketchEllipticalArcs`.)
   */
  decimals: number;
}

/** What a plan takes besides curves and points. */
export interface SketchImportExtras {
  /** Construction lines, already cut to a length (see `ConstructionLines`): each becomes a guide line. */
  guides?: readonly CutLine[];
  /** Texts, resolved against their fonts and placed (see `ImportedTexts`): each becomes a text statement. */
  texts?: readonly ResolvedText[];
}

/** A baseline turned less than this from level, in radians, is level: the text is placed by its anchor. */
const LEVEL = 1e-9;

const TWO_PI = 2 * Math.PI;

/**
 * The decimals past the plan's own that a number is written with when it
 * has to agree with others to within what the kernel tells apart: the
 * numbers of an elliptical arc's ellipse that its written ends settle.
 */
const FINE_DECIMALS = 4;

/**
 * An arc's radius holds its bulge while its centre is at least this share of
 * the radius away from its chord: a sweep under about 157°, or over about
 * 203°. Nearer a half turn the radius changes too little with the bulge.
 */
const ARC_RADIUS_HOLDS = 0.2;

/**
 * Drawing curves → the sketch statements that draw them.
 *
 * A sketch has lines, arcs, circles, ellipses, elliptical arcs and beziers,
 * so that is what the curves become. A B-spline is written as its own
 * Bézier pieces, one per knot span — exactly the same curve, whatever its
 * degree up to three. A rational spline and one of a higher degree have no
 * exact statement: they are fitted with cubics within the tolerance first,
 * and counted. A point of the file is a `point`: what a drill centre or a
 * datum mark is to a sketch.
 *
 * A construction line is a guide line: drawn, and kept out of profiles.
 * Where it was cut is no point of the drawing, so its ends join nothing —
 * fixed in place, each is fixed on its own — and it is told apart from the
 * curves: one lying on a line of the outline is not that line drawn twice.
 *
 * A text is the sketch's `text()`. Level, it is placed by its anchor, and
 * fixing it in place fixes that. Turned, it is written along a guide line
 * drawn on its baseline, as long as the text is wide: the line carries it,
 * and fixing the line's ends fixes the text.
 *
 * The plan also lists where ends meet. A sketch does not join ends because
 * they share coordinates — a `coincident` does — so without the joins an
 * imported outline would come apart at the first drag.
 */
export class SketchImport {
  static plan(
    curves: readonly Curve2D[],
    options: SketchImportOptions,
    points: readonly Vec2[] = [],
    extras: SketchImportExtras = {},
  ): SketchImportPlan {
    const tolerance = options.tolerance;
    const joinTolerance = Math.max(options.joinTolerance, tolerance);
    const rounding = (decimals: number) => {
      const scale = 10 ** decimals;
      return (value: number) => {
        const rounded = Math.round(value * scale) / scale;
        return rounded === 0 ? 0 : rounded;
      };
    };
    const round = rounding(options.decimals);
    const fine = rounding(options.decimals + FINE_DECIMALS);
    const point = (p: Vec2): Vec2 => ({ x: round(p.x), y: round(p.y) });

    const raw: DrawnPrimitive[] = [];
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
    for (const at of points) {
      raw.push({ kind: 'point', at });
    }
    for (const guide of extras.guides ?? []) {
      raw.push({ kind: 'line', start: guide.a, end: guide.b, guide: true });
    }

    const primitives: SketchPrimitive[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const primitive of raw) {
      const rounded = SketchImport.rounded(primitive, point, round, fine);
      // A point has no extent to lose; a curve under the join tolerance is a speck.
      if (!rounded || (rounded.kind !== 'point' && SketchImport.extent(rounded) <= joinTolerance)) {
        continue;
      }
      const key = SketchImport.key(rounded);
      if (seen.has(key)) {
        // `duplicates` counts curves: a point marked twice, or a construction line, is just written once.
        if (rounded.kind !== 'point' && !SketchImport.isGuide(rounded)) {
          duplicates++;
        }
        continue;
      }
      seen.add(key);
      primitives.push(rounded);
    }
    const joins = SketchImport.joins(primitives, joinTolerance);
    SketchImport.addTexts(extras.texts ?? [], primitives, point, round);

    return { primitives, joins, duplicates, approximated };
  }

  /**
   * The statements of `texts`, appended to `primitives`: first the
   * baselines of the turned ones, then every text. A text the file has
   * twice in one place is written once.
   */
  private static addTexts(
    texts: readonly ResolvedText[],
    primitives: SketchPrimitive[],
    point: (p: Vec2) => Vec2,
    round: (value: number) => number,
  ): void {
    const seen = new Set<string>();
    const written: SketchTextPrimitive[] = [];
    for (const text of texts) {
      const style = {
        kind: 'text' as const,
        text: text.text,
        font: text.font,
        bold: text.bold,
        italic: text.italic,
        size: round(text.size),
        align: text.align,
        lineSpacing: Math.round(text.lineSpacing * 1e6) / 1e6,
        letterSpacing: round(text.letterSpacing),
      };
      if (!(style.size > 0)) {
        continue;
      }
      const level = Math.abs(Math.sin(text.angle)) < LEVEL && Math.cos(text.angle) > 0;
      // The baseline a turned text is written along: under its first line, never shorter than the text is tall.
      const along = ImportedTexts.baseline({ ...text, widths: [Math.max(text.widths[0] ?? 0, text.size)] });
      const baseline = { start: point(along.a), end: point(along.b) };
      const at = point(text.at);
      const place = level ? `${at.x},${at.y}` : `${baseline.start.x},${baseline.start.y}|${baseline.end.x},${baseline.end.y}`;
      const key = JSON.stringify([style, place]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (level) {
        written.push({ ...style, at });
      } else {
        primitives.push({ kind: 'line', ...baseline, guide: true });
        written.push({ ...style, path: primitives.length - 1 });
      }
    }
    primitives.push(...written);
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
   * An elliptical arc between fixed ends has three things left to hold,
   * of its centre, its two semi-radii and its angle: which three depends
   * on where on the ellipse its ends are (see `SketchEllipticalArcs.holds`).
   *
   * One thing stays free: the angle of an ellipse turned off the sketch
   * axes, which no constraint holds — of a full ellipse, and of an
   * elliptical arc whose two ends are both on its ellipse's own axes (a
   * quarter, a half or three quarters of it, vertex to vertex), which are
   * the ends that do not hold it either. `decimals` are the plan's.
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
    const fixEnd = (primitive: number, end: SketchJoinEnd['end']) => {
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
            pins.push(SketchImport.centreAlong(index, primitive, Math.abs(chord.x) >= Math.abs(chord.y) ? 'y' : 'x', round));
          }
          break;
        }
        case 'eArc':
          fixEnd(index, 'start');
          fixEnd(index, 'end');
          for (const hold of SketchEllipticalArcs.holds(primitive)) {
            switch (hold) {
              case 'center':
                pins.push({ kind: 'fix', point: { primitive: index, point: 'center' } });
                break;
              case 'center-x':
                pins.push(SketchImport.centreAlong(index, primitive, 'x', round));
                break;
              case 'center-y':
                pins.push(SketchImport.centreAlong(index, primitive, 'y', round));
                break;
              case 'rx':
                pins.push({ kind: 'semi-radius', primitive: index, axis: 'x', value: primitive.rx });
                break;
              case 'ry':
                pins.push({ kind: 'semi-radius', primitive: index, axis: 'y', value: primitive.ry });
                break;
              case 'level':
                pins.push({ kind: 'level', primitive: index, direction: primitive.rotation === 0 ? 'horizontal' : 'vertical' });
                break;
            }
          }
          break;
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
        case 'point':
          fixEnd(index, 'point');
          break;
        case 'text':
          // A text on a baseline is held by the baseline's ends.
          if (primitive.at) {
            pins.push({ kind: 'fix', point: { primitive: index, point: 'anchor' } });
          }
          break;
      }
    });
    return pins;
  }

  /**
   * The pin that holds a centre along one sketch axis, by where it sits
   * from its curve's start: that far along the axis, or — when that is
   * nothing — level with it.
   */
  private static centreAlong(
    index: number,
    primitive: { start: Vec2; center: Vec2 },
    axis: 'x' | 'y',
    round: (value: number) => number,
  ): SketchPin {
    const value = round(Math.abs(primitive.center[axis] - primitive.start[axis]));
    if (value === 0) {
      // The same x is a vertical pair, the same y a horizontal one.
      return { kind: 'aligned', primitive: index, direction: axis === 'x' ? 'vertical' : 'horizontal' };
    }
    return { kind: 'offset', primitive: index, axis, value };
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
      case 'eArc':
        return SketchEllipticalArcs.outline(primitive);
      case 'bezier': {
        const steps = 12 * (primitive.points.length - 1);
        const points: Vec2[] = [];
        for (let i = 0; i <= steps; i++) {
          points.push(SketchImport.bezierPoint(primitive.points, i / steps));
        }
        return points;
      }
      case 'point':
        return [primitive.at];
      case 'text':
        return primitive.at ? [primitive.at] : [];
    }
  }

  /** Whether a primitive is a construction line: a line written as a guide. */
  static isGuide(primitive: SketchPrimitive): boolean {
    return primitive.kind === 'line' && primitive.guide === true;
  }

  // ─── Conversion ─────────────────────────────────────────────────────────

  /** Appends the statements of one curve; true when they approximate it. */
  private static convert(curve: Curve2D, tolerance: number, out: DrawnPrimitive[]): boolean {
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
          out.push({ kind: 'ellipse', center: curve.center, rx, ry: rx * curve.ratio, rotation: SketchEllipticalArcs.rotation(curve.major) });
        } else {
          out.push(SketchEllipticalArcs.of(curve));
        }
        return false;
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
  private static beziers(curve: BSpline, out: DrawnPrimitive[]): void {
    for (const points of BSplineCurve2D.bezierSegments(curve)) {
      if (points.length === 2) {
        out.push({ kind: 'line', start: points[0], end: points[1] });
      } else {
        out.push({ kind: 'bezier', points });
      }
    }
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

  /** The primitive as it is written; null when the rounding leaves nothing of it. `fine` rounds what has to be written finer than the rest. */
  private static rounded(
    primitive: DrawnPrimitive,
    point: (p: Vec2) => Vec2,
    round: (v: number) => number,
    fine: (v: number) => number,
  ): DrawnPrimitive | null {
    switch (primitive.kind) {
      case 'line':
        return {
          kind: 'line',
          start: point(primitive.start),
          end: point(primitive.end),
          ...(primitive.guide ? { guide: true as const } : {}),
        };
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
      case 'eArc':
        return SketchEllipticalArcs.rounded(primitive, point, round, fine);
      case 'bezier':
        return { kind: 'bezier', points: primitive.points.map(point) };
      case 'point':
        return { kind: 'point', at: point(primitive.at) };
    }
  }

  /** How far the primitive reaches: under the join tolerance it is a speck, not a curve. */
  private static extent(primitive: Exclude<DrawnPrimitive, { kind: 'point' }>): number {
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
      case 'eArc':
        return SketchEllipticalArcs.length(primitive);
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
  private static key(primitive: DrawnPrimitive): string {
    const p = (v: Vec2) => `${v.x},${v.y}`;
    const either = (forward: string, backward: string) => (forward < backward ? forward : backward);
    switch (primitive.kind) {
      case 'line':
        // A guide line is another thing than a line of the outline it may lie on.
        return `${primitive.guide ? 'g' : 'l'}|${either(`${p(primitive.start)}|${p(primitive.end)}`, `${p(primitive.end)}|${p(primitive.start)}`)}`;
      case 'arc':
        return `a|${p(primitive.start)}|${p(primitive.end)}|${p(primitive.center)}`;
      case 'circle':
        return `c|${p(primitive.center)}|${primitive.diameter}`;
      case 'ellipse':
        return `e|${p(primitive.center)}|${primitive.rx}|${primitive.ry}|${primitive.rotation}`;
      case 'eArc':
        return SketchEllipticalArcs.key(primitive);
      case 'bezier': {
        const forward = primitive.points.map(p).join('|');
        const backward = [...primitive.points].reverse().map(p).join('|');
        return `b|${either(forward, backward)}`;
      }
      case 'point':
        return `p|${p(primitive.at)}`;
    }
  }

  // ─── Joins ──────────────────────────────────────────────────────────────

  /**
   * The ends that sit within `tolerance` of each other, grouped (an end near
   * an end near a third is one meeting point) and each group written as a
   * star from its first end. Two ends of one line, arc or elliptical arc
   * never join: that would fold the curve onto a point. A bezier that closes on itself does.
   * A point primitive is an end of its own, so one drawn on a curve's end
   * stays on it. A guide line has no ends to join: they are where an
   * endless line was cut.
   */
  private static joins(primitives: readonly SketchPrimitive[], tolerance: number): SketchJoin[] {
    type End = SketchJoinEnd & { at: Vec2 };
    const ends: End[] = [];
    primitives.forEach((primitive, index) => {
      if (SketchImport.isGuide(primitive)) {
        return;
      }
      if (primitive.kind === 'line' || primitive.kind === 'arc' || primitive.kind === 'eArc') {
        ends.push({ primitive: index, end: 'start', at: primitive.start }, { primitive: index, end: 'end', at: primitive.end });
      } else if (primitive.kind === 'bezier') {
        ends.push(
          { primitive: index, end: 'start', at: primitive.points[0] },
          { primitive: index, end: 'end', at: primitive.points[primitive.points.length - 1] },
        );
      } else if (primitive.kind === 'point') {
        ends.push({ primitive: index, end: 'point', at: primitive.at });
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
