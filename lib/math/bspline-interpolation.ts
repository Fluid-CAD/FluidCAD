/**
 * Global B-spline interpolation of planar points (The NURBS Book, §9.2.1):
 * chord-length parameters, knots by averaging, and a banded linear system
 * solved densely. The resulting curve passes through every input point and
 * is C2 (for the cubic case).
 *
 * Exists because fluidcad-ocjs currently miscompiles the `Geom2dAPI` fitting
 * classes (both their constructors and `Init` produce corrupted curves);
 * `Geom2d_BSplineCurve`'s array constructor is unaffected, so we compute the
 * poles/knots ourselves and hand them over.
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

/** Largest knot span index whose half-open interval contains t. */
function findSpan(poleCount: number, degree: number, t: number, flatKnots: number[]): number {
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
function basisFunctions(span: number, t: number, degree: number, flatKnots: number[]): number[] {
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

/** Gaussian elimination with partial pivoting; solves A·x = b for both RHS columns. */
function solveDense(matrix: number[][], rhsX: number[], rhsY: number[]): { x: number[]; y: number[] } {
  const n = matrix.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][col]) < 1e-14) {
      throw new Error("B-spline interpolation: singular system (degenerate or duplicate points)");
    }
    if (pivot !== col) {
      [matrix[pivot], matrix[col]] = [matrix[col], matrix[pivot]];
      [rhsX[pivot], rhsX[col]] = [rhsX[col], rhsX[pivot]];
      [rhsY[pivot], rhsY[col]] = [rhsY[col], rhsY[pivot]];
    }
    for (let row = col + 1; row < n; row++) {
      const factor = matrix[row][col] / matrix[col][col];
      if (factor === 0) {
        continue;
      }
      for (let k = col; k < n; k++) {
        matrix[row][k] -= factor * matrix[col][k];
      }
      rhsX[row] -= factor * rhsX[col];
      rhsY[row] -= factor * rhsY[col];
    }
  }
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    let sumX = rhsX[row];
    let sumY = rhsY[row];
    for (let k = row + 1; k < n; k++) {
      sumX -= matrix[row][k] * x[k];
      sumY -= matrix[row][k] * y[k];
    }
    x[row] = sumX / matrix[row][row];
    y[row] = sumY / matrix[row][row];
  }
  return { x, y };
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
  const degree = Math.min(3, n);

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

  // Knots by averaging (NURBS book eq. 9.8): clamped ends, one internal knot
  // per unconstrained pole.
  const flatKnots: number[] = [];
  for (let i = 0; i <= degree; i++) {
    flatKnots.push(0);
  }
  for (let j = 1; j <= n - degree; j++) {
    let sum = 0;
    for (let i = j; i <= j + degree - 1; i++) {
      sum += params[i];
    }
    flatKnots.push(sum / degree);
  }
  for (let i = 0; i <= degree; i++) {
    flatKnots.push(1);
  }

  // Interpolation system: one basis row per parameter.
  const matrix: number[][] = [];
  const rhsX: number[] = [];
  const rhsY: number[] = [];
  for (let k = 0; k <= n; k++) {
    const row = new Array<number>(n + 1).fill(0);
    const span = findSpan(n + 1, degree, params[k], flatKnots);
    const values = basisFunctions(span, params[k], degree, flatKnots);
    for (let j = 0; j <= degree; j++) {
      row[span - degree + j] = values[j];
    }
    matrix.push(row);
    rhsX.push(points[k].x);
    rhsY.push(points[k].y);
  }
  const solved = solveDense(matrix, rhsX, rhsY);

  // Convert the flat knot vector to OCC's distinct-knots + multiplicities.
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

  return {
    poles: solved.x.map((x, i) => ({ x, y: solved.y[i] })),
    knots,
    multiplicities,
    degree,
  };
}
