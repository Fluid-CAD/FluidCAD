// Numerical rank via column-pivoted Householder QR.
//
// Part of lib/solver-core/ — see linalg.ts header for the no-imports
// rule this directory lives under.

export type MatrixRankInfo = {
  /** Number of accepted pivots — the numerical rank. */
  rank: number;
  /**
   * Original column indices in pivot-acceptance order (length = rank).
   * Columns not listed are the linearly dependent ones — the sketch
   * solver's redundant-row attribution runs on Jᵀ and reads the
   * missing indices as the redundant constraint rows.
   */
  pivots: number[];
};

/**
 * Numerical rank of an m×n matrix (row-major) via column-pivoted
 * Householder QR, plus the per-column pivot order. A pivot column whose
 * remaining norm falls to `1e-6 · |R₀₀|` (or below an absolute 1e-12
 * for the first pivot) ends the factorization; the count of accepted
 * pivots is the rank.
 *
 * Matrices here are tiny (closure rows × joint params for the assembly
 * loop-DOF report; constraint rows × sketch params for sketch
 * diagnostics), so the O(mn²) cost with fresh column norms per step is
 * irrelevant and avoids the cancellation drift of downdated norms.
 */
export function matrixRankWithPivots(A: Float64Array, m: number, n: number): MatrixRankInfo {
  if (m === 0 || n === 0) {
    return { rank: 0, pivots: [] };
  }
  const a = new Float64Array(A);
  // colIndex[j] = original index of the column currently in slot j.
  const colIndex = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    colIndex[j] = j;
  }
  const pivots: number[] = [];
  const kMax = Math.min(m, n);
  let r00 = 0;
  let rank = 0;
  for (let k = 0; k < kMax; k++) {
    // Pivot: the column with the largest remaining (rows k..m-1) norm.
    let bestSq = -1;
    let bestCol = k;
    for (let j = k; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) {
        const v = a[i * n + j];
        s += v * v;
      }
      if (s > bestSq) {
        bestSq = s;
        bestCol = j;
      }
    }
    const norm = Math.sqrt(Math.max(bestSq, 0));
    if (k === 0) {
      r00 = norm;
    }
    const tol = k === 0 ? 1e-12 : 1e-6 * r00;
    if (norm <= tol) {
      break;
    }
    if (bestCol !== k) {
      for (let i = 0; i < m; i++) {
        const tmp = a[i * n + k];
        a[i * n + k] = a[i * n + bestCol];
        a[i * n + bestCol] = tmp;
      }
      const tmpIdx = colIndex[k];
      colIndex[k] = colIndex[bestCol];
      colIndex[bestCol] = tmpIdx;
    }
    pivots.push(colIndex[k]);
    // Householder vector for column k over rows k..m-1:
    // v = x + sign(x₀)·‖x‖·e₁, then reflect the remaining columns.
    const x0 = a[k * n + k];
    const alpha = x0 >= 0 ? -norm : norm;
    const v = new Float64Array(m - k);
    v[0] = x0 - alpha;
    for (let i = k + 1; i < m; i++) {
      v[i - k] = a[i * n + k];
    }
    let vNorm2 = 0;
    for (let i = 0; i < v.length; i++) {
      vNorm2 += v[i] * v[i];
    }
    if (vNorm2 > 1e-300) {
      for (let j = k; j < n; j++) {
        let dot = 0;
        for (let i = 0; i < v.length; i++) {
          dot += v[i] * a[(k + i) * n + j];
        }
        const scale = (2 * dot) / vNorm2;
        for (let i = 0; i < v.length; i++) {
          a[(k + i) * n + j] -= scale * v[i];
        }
      }
    }
    rank++;
  }
  return { rank, pivots };
}

/** Numerical rank of an m×n matrix (row-major). See matrixRankWithPivots. */
export function matrixRank(A: Float64Array, m: number, n: number): number {
  return matrixRankWithPivots(A, m, n).rank;
}
