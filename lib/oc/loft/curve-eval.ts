import { findSpan, basisFunctions } from "../../math/bspline-interpolation.js";

/**
 * Plain-data B-spline evaluation for the loft pipeline. Sections and guides
 * live as pole/knot arrays between pipeline stages (see `CurveData`), and
 * evaluating them directly in JS avoids rebuilding native curves just to
 * sample a few points.
 */

/** Expands distinct knots + multiplicities into the flat knot sequence. */
export function flattenKnots(knots: ReadonlyArray<number>, multiplicities: ReadonlyArray<number>): number[] {
  const flat: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    for (let m = 0; m < multiplicities[i]; m++) {
      flat.push(knots[i]);
    }
  }
  return flat;
}

export interface EvaluableBSpline {
  degree: number;
  knots: number[];
  multiplicities: number[];
  poles: number[][];
  weights?: number[] | null;
}

/** Point on a (possibly rational) B-spline at parameter t. */
export function evaluateBSplinePoint(curve: EvaluableBSpline, t: number): number[] {
  const flat = flattenKnots(curve.knots, curve.multiplicities);
  const span = findSpan(curve.poles.length, curve.degree, t, flat);
  const values = basisFunctions(span, t, curve.degree, flat);

  const dimension = curve.poles[0].length;
  const numerator = new Array<number>(dimension).fill(0);
  let denominator = 0;
  for (let j = 0; j <= curve.degree; j++) {
    const poleIndex = span - curve.degree + j;
    const weight = curve.weights ? curve.weights[poleIndex] : 1;
    const blend = values[j] * weight;
    denominator += blend;
    for (let d = 0; d < dimension; d++) {
      numerator[d] += blend * curve.poles[poleIndex][d];
    }
  }
  return numerator.map(v => v / denominator);
}

/**
 * Point and first derivative of a (possibly rational) B-spline at t. At a
 * knot where the curve is only C0 the two sides disagree on the derivative:
 * `side` −1 evaluates the span ending at t, +1 the span starting there.
 */
export function evaluateBSplineDerivative(
  curve: EvaluableBSpline,
  t: number,
  side: -1 | 1 = 1,
): { point: number[]; derivative: number[] } {
  const flat = flattenKnots(curve.knots, curve.multiplicities);
  const degree = curve.degree;
  let span = findSpan(curve.poles.length, degree, t, flat);
  if (side < 0) {
    while (span > degree && flat[span] >= t) {
      span--;
    }
  }
  const values = basisFunctions(span, t, degree, flat);
  const lower = degree > 0 ? basisFunctions(span, t, degree - 1, flat) : [];

  const dimension = curve.poles[0].length;
  const numerator = new Array<number>(dimension).fill(0);
  const numeratorSlope = new Array<number>(dimension).fill(0);
  let denominator = 0;
  let denominatorSlope = 0;
  for (let j = 0; j <= degree; j++) {
    const i = span - degree + j;
    // N'(i,p) = p · ( N(i,p−1) / (u[i+p] − u[i]) − N(i+1,p−1) / (u[i+p+1] − u[i+1]) )
    let slope = 0;
    if (j > 0) {
      slope += lower[j - 1] / (flat[i + degree] - flat[i]);
    }
    if (j < degree) {
      slope -= lower[j] / (flat[i + degree + 1] - flat[i + 1]);
    }
    slope *= degree;

    const weight = curve.weights ? curve.weights[i] : 1;
    denominator += values[j] * weight;
    denominatorSlope += slope * weight;
    for (let d = 0; d < dimension; d++) {
      numerator[d] += values[j] * weight * curve.poles[i][d];
      numeratorSlope[d] += slope * weight * curve.poles[i][d];
    }
  }
  const point = numerator.map(v => v / denominator);
  return {
    point,
    derivative: numeratorSlope.map((v, d) => (v - denominatorSlope * point[d]) / denominator),
  };
}

/**
 * Parameter in [low, high] whose evaluated point lies closest to `target`:
 * dense sampling to bracket the minimum, then golden-section refinement.
 * Works for any point-valued curve evaluation (plain-data or native).
 *
 * On a closed curve both ends are the same point, and the minimum may sit
 * just inside either: when the best sample is an end, the other end's
 * bracket is refined too.
 */
export function closestCurveParameter(
  evaluate: (t: number) => number[],
  target: ReadonlyArray<number>,
  low = 0,
  high = 1,
  samples = 512,
): number {
  const distanceAt = (t: number) => {
    const p = evaluate(t);
    let sum = 0;
    for (let d = 0; d < target.length; d++) {
      sum += (p[d] - target[d]) * (p[d] - target[d]);
    }
    return sum;
  };

  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = distanceAt(low + ((high - low) * i) / samples);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }

  const refine = (index: number) => {
    let a = low + ((high - low) * Math.max(0, index - 1)) / samples;
    let b = low + ((high - low) * Math.min(samples, index + 1)) / samples;
    const phi = (Math.sqrt(5) - 1) / 2;
    let mid1 = b - phi * (b - a);
    let mid2 = a + phi * (b - a);
    let d1 = distanceAt(mid1);
    let d2 = distanceAt(mid2);
    for (let iteration = 0; iteration < 40; iteration++) {
      if (d1 <= d2) {
        b = mid2;
        mid2 = mid1;
        d2 = d1;
        mid1 = b - phi * (b - a);
        d1 = distanceAt(mid1);
      } else {
        a = mid1;
        mid1 = mid2;
        d1 = d2;
        mid2 = a + phi * (b - a);
        d2 = distanceAt(mid2);
      }
    }
    return (a + b) / 2;
  };

  const best = refine(bestIndex);
  if (bestIndex !== 0 && bestIndex !== samples) {
    return best;
  }
  const other = refine(bestIndex === 0 ? samples : 0);
  return distanceAt(other) < distanceAt(best) ? other : best;
}
