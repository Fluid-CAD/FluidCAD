// Dense linear-algebra kernels for the shared solver core.
//
// lib/solver-core/ is the dependency-free numeric core shared by the
// assembly solver (via the ui/src/solver/relaxation.ts re-export) and
// the 2D sketch constraint solver. Files in this directory may import
// nothing outside the directory — no OCCT, no DOM, no Node builtins —
// so the same code runs in the kernel (Node) and the browser. A test
// (lib/tests/solver-core/purity.test.ts) enforces this.

/**
 * Cholesky factorization A = L Lᵀ for an n×n SPD matrix stored
 * row-major. Returns L (lower triangular, also row-major) or null if
 * A is not positive definite. Uses the Cholesky-Banachiewicz algorithm:
 * straightforward and numerically stable for small matrices.
 *
 * The diagonal test is `!(sum > 0)` rather than `sum <= 0` so a NaN
 * pivot (e.g. from a NaN residual leaking into JᵀJ) fails the
 * factorization instead of silently producing a NaN factor.
 */
export function cholesky(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= L[i * n + k] * L[j * n + k];
      }
      if (i === j) {
        if (!(sum > 0)) {
          return null;
        }
        L[i * n + j] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}

/**
 * Solve L Lᵀ y = b for y, returning a new Float64Array.
 * Forward-substitute L z = b, then back-substitute Lᵀ y = z.
 */
export function choleskySolve(L: Float64Array, b: Float64Array, n: number): Float64Array {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) {
      s -= L[i * n + k] * z[k];
    }
    z[i] = s / L[i * n + i];
  }
  const y = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) {
      s -= L[k * n + i] * y[k];
    }
    y[i] = s / L[i * n + i];
  }
  return y;
}

/** Euclidean norm ‖v‖₂. */
export function vecNorm(v: ArrayLike<number>): number {
  return Math.sqrt(vecNorm2(v));
}

/** Squared Euclidean norm ‖v‖₂². */
export function vecNorm2(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i] * v[i];
  }
  return s;
}

/** Max norm ‖v‖∞. NaN entries propagate (the result is NaN). */
export function vecInfNorm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (Number.isNaN(a)) {
      return NaN;
    }
    if (a > s) {
      s = a;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Envelope (skyline) Cholesky.
//
// For the damped normal matrix of a sketch system under a
// bandwidth-reducing param ordering (lib/sketch-solver/decompose.ts
// runs reverse Cuthill-McKee), row i of A has its first structural
// nonzero at column firstNz[i] ≤ i. Cholesky fill never escapes the
// envelope (L[i][j] = 0 for j < firstNz[i] — provable by induction on
// the Banachiewicz recurrence), so factorization and solves can skip
// the known zeros: O(Σ profile·b) ≈ O(n·b²) for bandwidth b instead
// of O(n³/6). The surviving flops run in the same k-ascending order
// as the dense routines, so results are bit-identical to
// cholesky/choleskySolve on the same matrix.
//
// Storage stays dense row-major (entries outside the envelope are
// never read or written), which keeps the format shared with the
// dense path and lets callers reuse one buffer across iterations
// without re-zeroing it.

/**
 * Envelope Cholesky A = L Lᵀ into a caller-provided L buffer (n×n
 * row-major; entries outside the envelope are left untouched — every
 * reader below respects the envelope). Returns false if A is not
 * positive definite (NaN pivots fail the factorization, as in
 * `cholesky`).
 */
export function choleskyEnvelopeInto(
  A: Float64Array,
  n: number,
  firstNz: Int32Array,
  L: Float64Array,
): boolean {
  for (let i = 0; i < n; i++) {
    const fi = firstNz[i];
    const rowI = i * n;
    for (let j = fi; j <= i; j++) {
      let sum = A[rowI + j];
      const rowJ = j * n;
      const k0 = Math.max(fi, firstNz[j]);
      for (let k = k0; k < j; k++) {
        sum -= L[rowI + k] * L[rowJ + k];
      }
      if (i === j) {
        if (!(sum > 0)) {
          return false;
        }
        L[rowI + j] = Math.sqrt(sum);
      } else {
        L[rowI + j] = sum / L[rowJ + j];
      }
    }
  }
  return true;
}

/**
 * Column adjacency of an envelope: for each column i, the rows k > i
 * with firstNz[k] ≤ i (i.e. the sub-diagonal entries of column i of
 * L), listed in ascending k. Precomputed once per structure so the
 * back-substitution in choleskyEnvelopeSolveInto can walk exactly the
 * dense summation order restricted to structural nonzeros.
 */
export type EnvelopeColumns = {
  /** Prefix offsets into `rows`, length n+1. */
  start: Int32Array;
  /** Row indices, grouped per column, ascending within each column. */
  rows: Int32Array;
};

export function envelopeColumns(firstNz: Int32Array, n: number): EnvelopeColumns {
  const start = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    for (let i = firstNz[k]; i < k; i++) {
      start[i + 1]++;
    }
  }
  for (let i = 0; i < n; i++) {
    start[i + 1] += start[i];
  }
  const rows = new Int32Array(start[n]);
  const cursor = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    for (let i = firstNz[k]; i < k; i++) {
      rows[start[i] + cursor[i]++] = k;
    }
  }
  return { start, rows };
}

/**
 * Solve L Lᵀ y = b over an envelope factor from choleskyEnvelopeInto,
 * writing into caller-provided scratch z and output y (no
 * allocations). Flop-for-flop the dense choleskySolve restricted to
 * structural nonzeros, in the same summation order — bit-identical
 * results.
 */
export function choleskyEnvelopeSolveInto(
  L: Float64Array,
  b: Float64Array,
  n: number,
  firstNz: Int32Array,
  cols: EnvelopeColumns,
  z: Float64Array,
  y: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const rowI = i * n;
    for (let k = firstNz[i]; k < i; k++) {
      s -= L[rowI + k] * z[k];
    }
    z[i] = s / L[rowI + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    const end = cols.start[i + 1];
    for (let idx = cols.start[i]; idx < end; idx++) {
      const k = cols.rows[idx];
      s -= L[k * n + i] * y[k];
    }
    y[i] = s / L[i * n + i];
  }
}
