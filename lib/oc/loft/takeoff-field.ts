import { Vector3d } from "../../math/vector3d.js";
import { findSpan, basisFunctions, solveBanded } from "../../math/bspline-interpolation.js";
import { evaluateBSplineDerivative, evaluateBSplinePoint, flattenKnots, EvaluableBSpline } from "./curve-eval.js";

/**
 * The in-plane takeoff of a `tangent` loft condition: how fast, and which
 * way, every point of a closed section leaves it.
 *
 * The field is geometric. A point on a smooth stretch leaves along the
 * section's outward normal at the given rate; a corner leaves along its
 * miter, so both sides meeting there still advance at that rate; and the
 * miter's sideways part fades out along each of the two profile edges that
 * meet at the corner, linearly by arc length. A polygon therefore takes off
 * as its own offset polygon — sides stay straight, corners stay sharp — a
 * circle as a concentric one, and a teardrop as both at once: its round end
 * grows evenly while its point runs out along its two flanks.
 *
 * What the skin needs is one derivative vector per pole, blended by the
 * section's own (rational) basis. Reading the direction off the control
 * polygon pole by pole does not give the field above: it comes out damped
 * wherever the basis is wide, and a barrel between two circles of radius 40
 * came out three-lobed — 55 over the circle's on-curve poles, 50 between
 * them. The pole values are instead solved for, so the blend meets the
 * field exactly at the section's Greville points. That is exact everywhere
 * for circles and polygons, whose fields lie in the span of their own
 * basis; for any other curve `coarseSpans` names the knot spans too wide to
 * carry the field.
 */
export class TakeoffField {
  /** Tangent turns above this (radians) across a knot are a corner. */
  private static readonly CORNER_ANGLE = 0.01;
  /** A miter is never longer than this many times the takeoff rate (spikes). */
  private static readonly MITER_LIMIT = 4;
  private static readonly LENGTH_SAMPLES = 8;
  /** How far the blended field may stray from the true one, per unit rate. */
  private static readonly TOLERANCE = 1e-3;

  private readonly flat: number[];
  /** Greville abscissae: one node per pole, a C0 knot being its own node. */
  private readonly nodes: number[];
  /** Unit tangents arriving at and leaving each node; they differ at a corner. */
  private readonly sides: { before: Vector3d; after: Vector3d }[];
  /** Arc length from the section's start to each node. */
  private readonly lengths: number[];
  /** Per node: whether the section turns a corner there. The last node is the first again. */
  private readonly corners: boolean[];
  /** Per node: whether a profile edge ends there — a knot of full multiplicity, or the seam. */
  private readonly junctions: boolean[];

  private constructor(private readonly section: EvaluableBSpline, private readonly normal: Vector3d) {
    const { degree, poles } = section;
    this.flat = flattenKnots(section.knots, section.multiplicities);
    const last = poles.length - 1;

    this.nodes = [];
    for (let i = 0; i <= last; i++) {
      let sum = 0;
      for (let j = 1; j <= degree; j++) {
        sum += this.flat[i + j];
      }
      // A knot of full multiplicity is its pole's node to the last bit: the
      // average of equal values can land an ulp beside them, on one side of
      // a corner instead of on it.
      this.nodes.push(this.flat[i + 1] === this.flat[i + degree] ? this.flat[i + 1] : sum / degree);
    }

    // The curve is closed: its start continues from its end.
    this.sides = this.nodes.map((u, i) => ({
      before: TakeoffField.direction(evaluateBSplineDerivative(section, i === 0 ? this.nodes[last] : u, -1).derivative),
      after: TakeoffField.direction(evaluateBSplineDerivative(section, i === last ? this.nodes[0] : u, 1).derivative),
    }));
    this.corners = this.sides.map(side =>
      Math.acos(Math.min(1, Math.max(-1, side.before.dot(side.after)))) > TakeoffField.CORNER_ANGLE);
    this.junctions = this.nodes.map((_, i) =>
      i === 0 || i === last || this.flat[i + 1] === this.flat[i + degree]);

    this.lengths = [0];
    for (let i = 1; i <= last; i++) {
      this.lengths.push(this.lengths[i - 1] + this.lengthBetween(this.nodes[i - 1], this.nodes[i]));
    }
  }

  /**
   * One takeoff vector per pole of a closed section (first and last pole
   * coincide), of size `rate` along the outward normal. `normal` is the
   * section's plane normal; outward is tangent × normal.
   */
  static outward(section: EvaluableBSpline, normal: Vector3d, rate: number): number[][] {
    return new TakeoffField(section, normal).poleVectors(rate);
  }

  /**
   * Midpoints of the knot spans over which the section's basis cannot carry
   * its takeoff field to tolerance; empty when it can. Inserting them as
   * knots (into every section — the basis is shared) and asking again
   * converges: the blend's error falls with the span width to the power of
   * the degree.
   */
  static coarseSpans(section: EvaluableBSpline, normal: Vector3d): number[] {
    const field = new TakeoffField(section, normal);
    const vectors = field.poleVectors(1);
    const blend = { ...section, poles: vectors };

    const midpoints = new Set<number>();
    const count = section.poles.length;
    for (let i = 0; i + 1 < field.nodes.length; i++) {
      const [from, to] = [field.nodes[i], field.nodes[i + 1]];
      if (!(to > from)) {
        continue;
      }
      for (const fraction of [0.25, 0.5, 0.75]) {
        const u = from + (to - from) * fraction;
        const expected = field.target(u, i, 1);
        const actual = evaluateBSplinePoint(blend, u);
        if (Math.hypot(actual[0] - expected.x, actual[1] - expected.y, actual[2] - expected.z) > TakeoffField.TOLERANCE) {
          const span = findSpan(count, section.degree, u, field.flat);
          midpoints.add((field.flat[span] + field.flat[span + 1]) / 2);
        }
      }
    }
    return [...midpoints].sort((a, b) => a - b);
  }

  private poleVectors(rate: number): number[][] {
    const { degree, poles, weights } = this.section;
    const count = poles.length;

    const targets = this.nodes.map((u, i) => this.corners[i]
      ? this.miter(i, rate)
      : this.target(u, Math.min(i, count - 2), rate));

    // Σ R_i(node_k) · d_i = target_k, with R the section's own rational basis.
    const matrix = this.nodes.map(u => {
      const row = new Array<number>(count).fill(0);
      const span = findSpan(count, degree, u, this.flat);
      const values = basisFunctions(span, u, degree, this.flat);
      let denominator = 0;
      for (let j = 0; j <= degree; j++) {
        const index = span - degree + j;
        row[index] = values[j] * (weights ? weights[index] : 1);
        denominator += row[index];
      }
      return row.map(value => value / denominator);
    });
    const solved = solveBanded(matrix, [
      targets.map(target => target.x),
      targets.map(target => target.y),
      targets.map(target => target.z),
    ]);
    return poles.map((_, i) => solved.map(column => column[i]));
  }

  /**
   * The field at a parameter that is not a corner, lying between node
   * `interval` and the next one.
   */
  private target(u: number, interval: number, rate: number): Vector3d {
    const tangent = TakeoffField.direction(evaluateBSplineDerivative(this.section, u).derivative);
    const field = this.outwardOf(tangent).multiply(rate);

    // The profile edge u lies on, from one junction to the next.
    let from = interval;
    while (!this.junctions[from]) {
      from--;
    }
    let to = interval + 1;
    while (!this.junctions[to]) {
      to++;
    }
    if (!this.corners[from] && !this.corners[to]) {
      return field;
    }

    const length = this.lengths[interval] + this.lengthBetween(this.nodes[interval], u);
    const along = (length - this.lengths[from]) / (this.lengths[to] - this.lengths[from]);
    let slide = 0;
    if (this.corners[from]) {
      slide += this.miter(from, rate).dot(this.sides[from].after) * (1 - along);
    }
    if (this.corners[to]) {
      slide += this.miter(to, rate).dot(this.sides[to].before) * along;
    }
    return field.add(tangent.multiply(slide));
  }

  /** Where a corner goes: the vector advancing both of its sides at `rate`. */
  private miter(corner: number, rate: number): Vector3d {
    const a = this.outwardOf(this.sides[corner].before);
    const b = this.outwardOf(this.sides[corner].after);
    const spread = Math.max(1 + a.dot(b), 2 / (TakeoffField.MITER_LIMIT * TakeoffField.MITER_LIMIT));
    return a.add(b).multiply(rate / spread);
  }

  private outwardOf(tangent: Vector3d): Vector3d {
    return tangent.cross(this.normal).normalize();
  }

  private lengthBetween(from: number, to: number): number {
    let length = 0;
    let previous = evaluateBSplinePoint(this.section, from);
    for (let m = 1; m <= TakeoffField.LENGTH_SAMPLES; m++) {
      const point = evaluateBSplinePoint(this.section, from + (to - from) * m / TakeoffField.LENGTH_SAMPLES);
      length += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
      previous = point;
    }
    return length;
  }

  private static direction(derivative: number[]): Vector3d {
    const vector = new Vector3d(derivative[0], derivative[1], derivative[2]);
    if (vector.length() < 1e-12) {
      throw new Error("Loft tangent condition: profile winding is degenerate at a pole.");
    }
    return vector.normalize();
  }
}
