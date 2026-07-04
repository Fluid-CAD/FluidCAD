/**
 * Global B-spline interpolation (The NURBS Book, §9.2.1–9.2.2): chord-length
 * or caller-supplied parameters, knots by averaging, and a banded linear
 * system solved densely. The resulting curve passes through every input
 * point and is C2 (for the cubic case). Optional end-derivative constraints
 * (§9.2.2) pin the takeoff/arrival tangent vectors exactly — used by the
 * loft end conditions to control how a skinned surface leaves its profiles.
 *
 * Exists because fluidcad-ocjs currently miscompiles the `Geom2dAPI` fitting
 * classes (both their constructors and `Init` produce corrupted curves);
 * the `Geom_BSplineCurve`/`Geom2d_BSplineCurve` array constructors are
 * unaffected, so we compute the poles/knots ourselves and hand them over.
 */

export interface XY {
  x: number;
  y: number;
}

export interface BSpline2dData {
  poles: XY[];
  /** Distinct knot values (OCC convention). */
  knots: number[];
  /** Multiplicity per distinct knot. */
  multiplicities: number[];
  degree: number;
}

/** Dimension-agnostic interpolation result; each pole is one point (length = dimension). */
export interface BSplineCurveData {
  poles: number[][];
  /** Distinct knot values (OCC convention). */
  knots: number[];
  /** Multiplicity per distinct knot. */
  multiplicities: number[];
  degree: number;
}

/** Largest knot span index whose half-open interval contains t. */
export function findSpan(poleCount: number, degree: number, t: number, flatKnots: number[]): number {
  const n = poleCount - 1;
  if (t >= flatKnots[n + 1]) {
    return n;
  }
  let low = degree;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (t < flatKnots[mid] || t >= flatKnots[mid + 1]) {
    if (t < flatKnots[mid]) {
      high = mid;
    } else {
      low = mid;
    }
    mid = (low + high) >> 1;
  }
  return mid;
}

/** Nonzero basis function values N[span-degree .. span] at t (Cox–de Boor). */
export function basisFunctions(span: number, t: number, degree: number, flatKnots: number[]): number[] {
  const values = [1];
  const left: number[] = [];
  const right: number[] = [];
  for (let j = 1; j <= degree; j++) {
    left[j] = t - flatKnots[span + 1 - j];
    right[j] = flatKnots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = values[r] / (right[r + 1] + left[j - r]);
      values[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    values[j] = saved;
  }
  return values;
}

/**
 * Gaussian elimination restricted to the matrix band; solves A·x = b for
 * every RHS column at once. Mutates its inputs.
 *
 * B-spline collocation matrices are banded (bandwidth ≤ degree) and totally
 * positive, so elimination without pivoting is stable (de Boor) — and the
 * band restriction turns the O(n³) dense solve into O(n·b²), which is what
 * makes dense-sample curve approximation affordable.
 */
function solveBanded(matrix: number[][], rhsColumns: number[][]): number[][] {
  const n = matrix.length;

  let lowerBandwidth = 0;
  let upperBandwidth = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (matrix[row][col] !== 0) {
        lowerBandwidth = Math.max(lowerBandwidth, row - col);
        upperBandwidth = Math.max(upperBandwidth, col - row);
      }
    }
  }

  for (let col = 0; col < n; col++) {
    if (Math.abs(matrix[col][col]) < 1e-14) {
      throw new Error("B-spline interpolation: singular system (degenerate or duplicate points)");
    }
    const lastRow = Math.min(n - 1, col + lowerBandwidth);
    const lastCol = Math.min(n - 1, col + upperBandwidth);
    for (let row = col + 1; row <= lastRow; row++) {
      const factor = matrix[row][col] / matrix[col][col];
      if (factor === 0) {
        continue;
      }
      for (let k = col; k <= lastCol; k++) {
        matrix[row][k] -= factor * matrix[col][k];
      }
      for (const rhs of rhsColumns) {
        rhs[row] -= factor * rhs[col];
      }
    }
  }
  const solutions = rhsColumns.map(() => new Array<number>(n));
  for (let row = n - 1; row >= 0; row--) {
    const lastCol = Math.min(n - 1, row + upperBandwidth);
    for (let d = 0; d < rhsColumns.length; d++) {
      let sum = rhsColumns[d][row];
      for (let k = row + 1; k <= lastCol; k++) {
        sum -= matrix[row][k] * solutions[d][k];
      }
      solutions[d][row] = sum / matrix[row][row];
    }
  }
  return solutions;
}

/** Converts a flat knot vector to OCC's distinct-knots + multiplicities. */
function toDistinctKnots(flatKnots: number[]): { knots: number[]; multiplicities: number[] } {
  const knots: number[] = [];
  const multiplicities: number[] = [];
  for (const knot of flatKnots) {
    if (knots.length > 0 && knot === knots[knots.length - 1]) {
      multiplicities[multiplicities.length - 1]++;
    } else {
      knots.push(knot);
      multiplicities.push(1);
    }
  }
  return { knots, multiplicities };
}

/** Drops consecutive points closer than a millionth of the total chord. */
function dedupe(points: ReadonlyArray<XY>): XY[] {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const minChord = Math.max(1e-12, total * 1e-6);
  const result: XY[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) >= minChord) {
      result.push(points[i]);
    }
  }
  // Never drop the true endpoint: replace the last kept point if needed.
  const last = points[points.length - 1];
  const kept = result[result.length - 1];
  if (kept.x !== last.x || kept.y !== last.y) {
    if (result.length > 1) {
      result[result.length - 1] = last;
    } else {
      result.push(last);
    }
  }
  return result;
}

/**
 * Interpolates points (of any dimension) with a B-spline of degree up to 3,
 * passing exactly through every point at the given parameters. Optional end
 * derivatives constrain the curve's takeoff / arrival vectors (with respect
 * to the same parameterization as `params`), adding one pole per constraint
 * (The NURBS Book §9.2.2).
 *
 * With an end derivative D at a clamped end, the neighbouring pole is pinned
 * directly (P1 = P0 + D·Δu/p and its mirror), so the constraint is exact and
 * the linear system only solves for the remaining interior poles.
 */
export function interpolateWithDerivatives(
  points: ReadonlyArray<ReadonlyArray<number>>,
  params: ReadonlyArray<number>,
  startDerivative?: ReadonlyArray<number>,
  endDerivative?: ReadonlyArray<number>,
): BSplineCurveData {
  const pointCount = points.length;
  if (pointCount < 2) {
    throw new Error("B-spline interpolation needs at least two points");
  }
  if (params.length !== pointCount) {
    throw new Error("B-spline interpolation: params must match points in length");
  }
  for (let i = 1; i < pointCount; i++) {
    if (!(params[i] > params[i - 1])) {
      throw new Error("B-spline interpolation: params must be strictly increasing");
    }
  }
  const dimension = points[0].length;
  for (const derivative of [startDerivative, endDerivative]) {
    if (derivative && derivative.length !== dimension) {
      throw new Error("B-spline interpolation: derivative dimension must match points");
    }
  }

  const constraintCount = (startDerivative ? 1 : 0) + (endDerivative ? 1 : 0);
  const poleCount = pointCount + constraintCount;
  const degree = Math.min(3, poleCount - 1);

  // Knots by averaging (NURBS book eq. 9.8) over a parameter list padded with
  // one extra copy of the first/last parameter per derivative constraint —
  // this reduces to eq. 9.8 unconstrained and to eq. 9.11 with both ends
  // constrained, and keeps the collocation matrix nonsingular in between.
  const padded: number[] = [params[0]];
  if (startDerivative) {
    padded.push(params[0]);
  }
  for (let i = 1; i < pointCount - 1; i++) {
    padded.push(params[i]);
  }
  if (endDerivative) {
    padded.push(params[pointCount - 1]);
  }
  padded.push(params[pointCount - 1]);

  const flatKnots: number[] = [];
  for (let i = 0; i <= degree; i++) {
    flatKnots.push(params[0]);
  }
  for (let j = 1; j <= poleCount - 1 - degree; j++) {
    let sum = 0;
    for (let i = j; i <= j + degree - 1; i++) {
      sum += padded[i];
    }
    flatKnots.push(sum / degree);
  }
  for (let i = 0; i <= degree; i++) {
    flatKnots.push(params[pointCount - 1]);
  }

  // Pinned poles: clamped endpoints, plus the derivative neighbours.
  const poles: (number[] | null)[] = new Array(poleCount).fill(null);
  poles[0] = [...points[0]];
  poles[poleCount - 1] = [...points[pointCount - 1]];
  if (startDerivative) {
    const span = (flatKnots[degree + 1] - params[0]) / degree;
    poles[1] = points[0].map((v, d) => v + startDerivative[d] * span);
  }
  if (endDerivative) {
    const span = (params[pointCount - 1] - flatKnots[poleCount - 1]) / degree;
    poles[poleCount - 2] = points[pointCount - 1].map((v, d) => v - endDerivative[d] * span);
  }

  const unknownIndices: number[] = [];
  for (let i = 0; i < poleCount; i++) {
    if (poles[i] === null) {
      unknownIndices.push(i);
    }
  }

  if (unknownIndices.length > 0) {
    const columnOfPole = new Map<number, number>();
    unknownIndices.forEach((poleIndex, column) => columnOfPole.set(poleIndex, column));

    // One collocation row per interior point; pinned poles move to the RHS.
    const matrix: number[][] = [];
    const rhsColumns: number[][] = Array.from({ length: dimension }, () => []);
    for (let k = 1; k <= pointCount - 2; k++) {
      const row = new Array<number>(unknownIndices.length).fill(0);
      const rhs = [...points[k]];
      const span = findSpan(poleCount, degree, params[k], flatKnots);
      const values = basisFunctions(span, params[k], degree, flatKnots);
      for (let j = 0; j <= degree; j++) {
        const poleIndex = span - degree + j;
        const pinned = poles[poleIndex];
        if (pinned) {
          for (let d = 0; d < dimension; d++) {
            rhs[d] -= values[j] * pinned[d];
          }
        } else {
          row[columnOfPole.get(poleIndex)!] = values[j];
        }
      }
      matrix.push(row);
      for (let d = 0; d < dimension; d++) {
        rhsColumns[d].push(rhs[d]);
      }
    }

    const solved = solveBanded(matrix, rhsColumns);
    unknownIndices.forEach((poleIndex, column) => {
      poles[poleIndex] = solved.map(solution => solution[column]);
    });
  }

  const { knots, multiplicities } = toDistinctKnots(flatKnots);
  return {
    poles: poles as number[][],
    knots,
    multiplicities,
    degree,
  };
}

/**
 * Interpolates the given planar points with a B-spline of degree up to 3
 * (lower for 2 or 3 points). The curve passes exactly through every point,
 * in order, parameterized by chord length.
 */
export function interpolateBSpline2d(rawPoints: ReadonlyArray<XY>): BSpline2dData {
  const points = dedupe(rawPoints);
  if (points.length < 2) {
    throw new Error("B-spline interpolation needs at least two distinct points");
  }

  const n = points.length - 1;

  // Chord-length parameters, normalized to [0, 1].
  const params = new Array<number>(points.length);
  params[0] = 0;
  for (let i = 1; i <= n; i++) {
    params[i] = params[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = params[n];
  for (let i = 1; i <= n; i++) {
    params[i] /= total;
  }
  params[n] = 1;

  const data = interpolateWithDerivatives(points.map(p => [p.x, p.y]), params);
  return {
    poles: data.poles.map(p => ({ x: p[0], y: p[1] })),
    knots: data.knots,
    multiplicities: data.multiplicities,
    degree: data.degree,
  };
}
