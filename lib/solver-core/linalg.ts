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
