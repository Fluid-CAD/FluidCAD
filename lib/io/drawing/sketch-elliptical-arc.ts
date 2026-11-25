import type { Curve2D, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";
import { ellipseArcSpan, ellipseParamOf, projectOntoEllipse, sampleEllipseArc } from "../../sketch-solver/earc-geometry.js";
import type { EllipseFrame } from "../../sketch-solver/earc-geometry.js";

type OpenEllipse = Extract<Curve2D, { kind: 'ellipse' }>;

/**
 * The arguments of `eArc(start, end, center, rx, ry, rotation)`: an open
 * piece of an ellipse, counter-clockwise from `start` to `end`, `rotation`
 * the angle of the RX axis in degrees.
 */
export type SketchEllipticalArc = {
  kind: 'eArc';
  start: Vec2;
  end: Vec2;
  center: Vec2;
  rx: number;
  ry: number;
  rotation: number;
};

/** The full ellipse an elliptical arc is written as when its two ends are written as one point. */
type WholeEllipse = { kind: 'ellipse'; center: Vec2; rx: number; ry: number; rotation: number };

/**
 * One thing that holds an elliptical arc between its two fixed ends: its
 * centre (both coordinates, or the one along X or along Y), a semi-radius,
 * or its RX axis lying along a sketch axis.
 */
export type EllipticalArcHold = 'center' | 'center-x' | 'center-y' | 'rx' | 'ry' | 'level';

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

/** The ellipse's five numbers, as columns of the ends' gradients. */
const CX = 0;
const CY = 1;
const RX = 2;
const RY = 3;
const TURN = 4;

/**
 * Every way to hold an ellipse through two fixed points: three of its five
 * numbers are held, and the two points settle the other two (`left`). The
 * plainest to read come first: the centre fixed, then both radii.
 */
const HOLDS: readonly { left: readonly [number, number]; holds: readonly EllipticalArcHold[] }[] = [
  { left: [RX, RY], holds: ['center', 'level'] },
  { left: [RY, TURN], holds: ['center', 'rx'] },
  { left: [RX, TURN], holds: ['center', 'ry'] },
  { left: [CX, CY], holds: ['rx', 'ry', 'level'] },
  { left: [CY, TURN], holds: ['rx', 'ry', 'center-x'] },
  { left: [CX, TURN], holds: ['rx', 'ry', 'center-y'] },
  { left: [RY, CY], holds: ['rx', 'center-x', 'level'] },
  { left: [RY, CX], holds: ['rx', 'center-y', 'level'] },
  { left: [RX, CY], holds: ['ry', 'center-x', 'level'] },
  { left: [RX, CX], holds: ['ry', 'center-y', 'level'] },
];

/**
 * The pairs of an ellipse's numbers its written ends can be made to settle
 * exactly (see `SketchEllipticalArcs.through`): both semi-radii first, a
 * coordinate of the centre only where the ends cannot tell a radius. Never
 * the angle: an arc along a sketch axis stays along it.
 */
const SETTLED: readonly (readonly [number, number])[] = [[RX, RY], [RY, CY], [RY, CX], [RX, CY], [RX, CX], [CX, CY]];

/** How far off its ellipse a written end may be left, as a share of its radii: far under what any kernel tells apart. */
const ON_ELLIPSE = 1e-12;

/**
 * A pair is settled by the written ends when the ends settle it at least
 * this share as well as the best pair: low, so that it is the radii
 * wherever the ends say anything of both, and the centre stays the round
 * number it was written as.
 */
const SETTLES = 0.1;

/**
 * How well the two ends settle what is left to them goes from 0 (not at
 * all: the ellipse can still move with its ends in place) to 1. A way to
 * hold the arc is taken when its ends do at least this share as well as
 * in the best way.
 */
const NEAR_BEST = 0.5;

/**
 * Under this, the ends of an arc turned off the sketch axes do not settle
 * its angle: both sit on the ellipse's own axes, or within about half a
 * degree of them, where turning the ellipse about its centre moves
 * neither end off it — or the ellipse is all but a circle, which looks the
 * same however it is turned. The solver stops telling such a hold from
 * none at about a three-hundredth of this.
 */
const ANGLE_HOLDS = 0.01;

/**
 * An open elliptical arc of a drawing as the sketch's `eArc` statement.
 *
 * The statement names the arc by its two ends, counter-clockwise, on the
 * ellipse its other four arguments describe. An end that is not exactly on
 * that ellipse is read as the point of the ellipse in its direction — so
 * numbers each rounded on their own would draw the arc's ends a rounding
 * step away from where they are written, and from the end of a line
 * written at the same point. Nothing holds those together unless a join
 * is written, and an outline open by a millionth encloses nothing. So the
 * written ends are put on the written ellipse (see `EllipticalArcEnds`),
 * and the ellipse keeps the numbers of the file.
 */
export class SketchEllipticalArcs {
  /** The angle of an ellipse's long axis, in degrees. The axis has no direction: the angle is kept in (−90°, 90°]. */
  static rotation(major: Vec2): number {
    let rotation = Math.atan2(major.y, major.x) / DEG;
    // (The margin keeps a −90° that floating point left a hair short on the 90° side.)
    if (rotation > 90 + 1e-9) {
      rotation -= 180;
    } else if (rotation <= -90 + 1e-9) {
      rotation += 180;
    }
    return rotation;
  }

  /** The statement of an open ellipse curve: the same arc, by its ends. */
  static of(curve: OpenEllipse): SketchEllipticalArc {
    const rx = Math.hypot(curve.major.x, curve.major.y);
    return {
      kind: 'eArc',
      start: Curves.ellipsePoint(curve, curve.start),
      end: Curves.ellipsePoint(curve, curve.end),
      center: curve.center,
      rx,
      ry: rx * curve.ratio,
      rotation: SketchEllipticalArcs.rotation(curve.major),
    };
  }

  /**
   * The arc as it is written. The statement tells a short arc from one
   * that goes nearly all the way round by the order of its ends alone, so
   * ends the rounding wrote as one point, or carried past each other,
   * would draw the other piece: such an arc is the whole ellipse when it
   * went most of the way round, and nothing (null) when it went nowhere.
   * Every number is rounded with `round`, the ends too: where they are put
   * on the ellipse is for `EllipticalArcEnds`, once the plan's ends are
   * known.
   */
  static rounded(
    arc: SketchEllipticalArc,
    point: (p: Vec2) => Vec2,
    round: (value: number) => number,
  ): SketchEllipticalArc | WholeEllipse | null {
    const written: SketchEllipticalArc = {
      kind: 'eArc',
      start: point(arc.start),
      end: point(arc.end),
      center: point(arc.center),
      rx: round(arc.rx),
      ry: round(arc.ry),
      rotation: round(arc.rotation),
    };
    if (!(written.rx > 0) || !(written.ry > 0)) {
      return null;
    }
    const onePoint = written.start.x === written.end.x && written.start.y === written.end.y;
    if (onePoint || !SketchEllipticalArcs.sameWay(arc, written)) {
      return SketchEllipticalArcs.sweep(arc) > Math.PI
        ? { kind: 'ellipse', center: written.center, rx: written.rx, ry: written.ry, rotation: written.rotation }
        : null;
    }
    return written;
  }

  /**
   * The point of the arc's ellipse that the written point `at` names (the
   * one the statement reads it as), rounded with `fine`: written there, an
   * end is on the ellipse to within what the kernel tells apart, and is
   * drawn where it is written. A point already on the ellipse to the
   * decimals of `fine` is written as it is.
   */
  static onEllipse(arc: SketchEllipticalArc, at: Vec2, fine: (value: number) => number): Vec2 {
    const [x, y] = projectOntoEllipse(SketchEllipticalArcs.frame(arc), at.x, at.y);
    return { x: fine(x), y: fine(y) };
  }

  /** Whether `moved` runs round its ellipse the way `arc` does: its ends moved, not carried past each other. */
  static sameWay(arc: SketchEllipticalArc, moved: SketchEllipticalArc): boolean {
    return Math.abs(SketchEllipticalArcs.sweep(moved) - SketchEllipticalArcs.sweep(arc)) <= Math.PI;
  }

  /**
   * The written arc on an ellipse that passes through its two written
   * ends: the pair of numbers the ends settle best (see {@link SETTLED})
   * is solved for them, and rounded with `fine`. The arc as it is when the
   * ends settle nothing better than the rounding left it. For an arc whose
   * ends cannot be moved onto its ellipse: where it meets another
   * elliptical arc (see `EllipticalArcEnds`).
   */
  static through(written: SketchEllipticalArc, fine: (value: number) => number): SketchEllipticalArc {
    const settled = SketchEllipticalArcs.choose(
      SETTLED,
      [SketchEllipticalArcs.gradient(written, written.start), SketchEllipticalArcs.gradient(written, written.end)],
      [CX, CY, RX, RY],
      SETTLES,
    );
    if (!settled) {
      return written;
    }
    const [i, j] = SETTLED[settled.index];
    const values = [written.center.x, written.center.y, written.rx, written.ry];
    const withValues = (): SketchEllipticalArc => ({
      ...written,
      center: { x: values[CX], y: values[CY] },
      rx: values[RX],
      ry: values[RY],
    });
    // Newton's steps on "both ends are on the ellipse", over the two numbers: the rounding left it a step or two away.
    for (let step = 0; step < 6; step++) {
      const arc = withValues();
      const off = [SketchEllipticalArcs.off(arc, arc.start), SketchEllipticalArcs.off(arc, arc.end)];
      if (Math.max(Math.abs(off[0]), Math.abs(off[1])) <= ON_ELLIPSE) {
        break;
      }
      const a = SketchEllipticalArcs.gradient(arc, arc.start);
      const b = SketchEllipticalArcs.gradient(arc, arc.end);
      const det = a[i] * b[j] - a[j] * b[i];
      values[i] -= (off[0] * b[j] - off[1] * a[j]) / det;
      values[j] -= (a[i] * off[1] - b[i] * off[0]) / det;
      if (!values.every(Number.isFinite) || !(values[RX] > 0) || !(values[RY] > 0)) {
        return written;
      }
    }
    values[i] = fine(values[i]);
    values[j] = fine(values[j]);
    const through = withValues();
    // Only taken when it is the better arc: nearer its ends than the rounding alone left it.
    const miss = (arc: SketchEllipticalArc) =>
      Math.abs(SketchEllipticalArcs.off(arc, arc.start)) + Math.abs(SketchEllipticalArcs.off(arc, arc.end));
    return through.rx > 0 && through.ry > 0 && miss(through) < miss(written) ? through : written;
  }

  /** The points a preview draws the arc through, from its start to its end. */
  static outline(arc: SketchEllipticalArc): Vec2[] {
    const span = ellipseArcSpan(
      SketchEllipticalArcs.frame(arc),
      [arc.start.x, arc.start.y],
      [arc.end.x, arc.end.y],
      false,
    );
    const steps = Math.max(4, Math.ceil((Math.abs(span.sweep) / TWO_PI) * 72));
    return sampleEllipseArc(span, steps).map(([x, y]) => ({ x, y }));
  }

  /** The arc's length along the curve: its ends may be close while it goes most of the way round. */
  static length(arc: SketchEllipticalArc): number {
    const points = SketchEllipticalArcs.outline(arc);
    let length = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    }
    return length;
  }

  /** The same key for the same arc. A drawing's arcs all run counter-clockwise, so one drawn the other way is the same arc already. */
  static key(arc: SketchEllipticalArc): string {
    const p = (v: Vec2) => `${v.x},${v.y}`;
    return `ea|${p(arc.start)}|${p(arc.end)}|${p(arc.center)}|${arc.rx}|${arc.ry}|${arc.rotation}`;
  }

  /**
   * What holds the arc once its two ends are fixed, leaving it no freedom
   * and stating nothing twice.
   *
   * An ellipse is five numbers — a centre, two semi-radii, an angle — and
   * two fixed points on it settle two of them, so three more are held.
   * Which three matters: a quarter of an ellipse between two of its
   * vertices is the same to first order whatever its radii say about a
   * turn, and half an ellipse has its centre on its chord whatever its
   * other radius is. So the choice is measured, not guessed: of every
   * three that can be held (see {@link HOLDS}), the first whose remaining
   * two are settled by the ends nearly as well as the best.
   *
   * An arc's angle has a constraint only when its RX axis lies along a
   * sketch axis. Turned off them the ends have to settle the angle, and
   * the ends of an arc that runs between its ellipse's own axes — a
   * quarter, a half, three quarters, vertex to vertex — do not: then two
   * things are held and the angle stays free.
   */
  static holds(arc: SketchEllipticalArc): EllipticalArcHold[] {
    const rows = [SketchEllipticalArcs.gradient(arc, arc.start), SketchEllipticalArcs.gradient(arc, arc.end)];
    const level = arc.rotation === 0 || Math.abs(arc.rotation) === 90;
    const all = [CX, CY, RX, RY, TURN];
    const usable = HOLDS.filter((choice) => level || !choice.holds.includes('level'));
    const held = SketchEllipticalArcs.choose(usable.map((choice) => choice.left), rows, all, NEAR_BEST);
    if (held && (level || held.best >= ANGLE_HOLDS)) {
      return [...usable[held.index].holds];
    }
    // Nothing holds the angle: what is held is what would be beside a level arc's angle.
    const levelled = HOLDS.filter((choice) => choice.holds.includes('level'));
    const withoutAngle = SketchEllipticalArcs.choose(levelled.map((choice) => choice.left), rows, [CX, CY, RX, RY], NEAR_BEST);
    return withoutAngle ? levelled[withoutAngle.index].holds.filter((hold) => hold !== 'level') : [];
  }

  /**
   * Of `pairs` of an ellipse's numbers, the first the two ends settle at
   * least `share` as well as the best of them, and how well that best is
   * settled; null when none is settled at all. `rows` are the ends'
   * gradients, and `columns` the numbers that are not held: how well a
   * pair is settled is measured against everything the ends could move
   * among those.
   */
  private static choose(
    pairs: readonly (readonly [number, number])[],
    rows: number[][],
    columns: readonly number[],
    share: number,
  ): { index: number; best: number } | null {
    // How far the two ends' gradients are from saying the same thing, over `columns`.
    const dot = (a: number[], b: number[]) => columns.reduce((sum, c) => sum + a[c] * b[c], 0);
    const spread = Math.sqrt(Math.max(0, dot(rows[0], rows[0]) * dot(rows[1], rows[1]) - dot(rows[0], rows[1]) ** 2));
    if (!(spread > 0)) {
      return null;
    }
    const settled = pairs.map(([i, j]) => Math.abs(rows[0][i] * rows[1][j] - rows[0][j] * rows[1][i]) / spread);
    const best = Math.max(0, ...settled);
    const index = settled.findIndex((value) => value > 0 && value >= best * share);
    return index < 0 ? null : { index, best };
  }

  private static frame(arc: SketchEllipticalArc): EllipseFrame {
    return { cx: arc.center.x, cy: arc.center.y, rx: arc.rx, ry: arc.ry, theta: arc.rotation * DEG };
  }

  /** How far round the ellipse the arc goes from its start to its end, in [0, 2π). */
  private static sweep(arc: SketchEllipticalArc): number {
    const frame = SketchEllipticalArcs.frame(arc);
    const from = ellipseParamOf(frame, arc.start.x, arc.start.y);
    const to = ellipseParamOf(frame, arc.end.x, arc.end.y);
    const sweep = (to - from) % TWO_PI;
    return sweep < 0 ? sweep + TWO_PI : sweep;
  }

  /** The point `at` in the ellipse's own frame: along its RX axis, along its RY axis. */
  private static local(arc: SketchEllipticalArc, at: Vec2): { x: number; y: number; cos: number; sin: number } {
    const theta = arc.rotation * DEG;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const dx = at.x - arc.center.x;
    const dy = at.y - arc.center.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos, cos, sin };
  }

  /** How far off the ellipse the point `at` is: (x/rx)² + (y/ry)² − 1 in the ellipse's own frame, nothing on it. */
  private static off(arc: SketchEllipticalArc, at: Vec2): number {
    const { x, y } = SketchEllipticalArcs.local(arc, at);
    return (x / arc.rx) ** 2 + (y / arc.ry) ** 2 - 1;
  }

  /**
   * How "the point `at` is on the ellipse" ({@link off}) changes with each
   * of the ellipse's five numbers. The angle is counted as the length it
   * moves a point one RX away, so the five compare.
   */
  private static gradient(arc: SketchEllipticalArc, at: Vec2): number[] {
    const { x, y, cos, sin } = SketchEllipticalArcs.local(arc, at);
    const u = x / (arc.rx * arc.rx);
    const v = y / (arc.ry * arc.ry);
    const row: number[] = [];
    row[CX] = 2 * (-u * cos + v * sin);
    row[CY] = 2 * (-u * sin - v * cos);
    row[RX] = (-2 * u * x) / arc.rx;
    row[RY] = (-2 * v * y) / arc.ry;
    row[TURN] = (2 * (u * y - v * x)) / arc.rx;
    return row;
  }
}
