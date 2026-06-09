// Levenberg-Marquardt least-squares driver.
//
// Used by the closed-loop solver pass to relax body poses inside loop
// components after the spanning-tree warm-start has run. The warm-start
// only covers the spanning tree, so loop closures are expressed as
// JS-side residuals and an LM iteration brings the loop bodies onto the
// closure manifold.
//
// Implementation is hand-rolled to keep the dep graph clean. The
// problem size is small (typically 4 bodies × 7 params = 28 variables,
// ~25 residuals); a Cholesky-based linear solve costs microseconds.
//
// Algorithm (Gauss-Newton with Marquardt damping):
//   1. r ← evaluate(x); rNorm ← ||r||
//   2. J ← forward-FD Jacobian (m × n).
//   3. Solve (JᵀJ + λI) Δx = -Jᵀr via Cholesky.
//   4. Try x_new = x + Δx; if ||r(x_new)|| < ||r(x)||, accept and
//      decrease λ by 2; else reject and increase λ by 2.
//   5. After each accepted step, call `normalize(x)` so the caller can
//      re-project quaternions onto the unit-norm manifold.
//   6. Stop on ||Δx|| < tol or iters reached.
//
// The forward-FD step size for each variable is `h_rel * max(1, |x_j|)`
// with `h_rel = 1e-6`. Centered FD doubles eval count for ~1 digit of
// accuracy gain; defer until numerical noise shows up.

export type LMOptions = {
  /** Maximum LM iterations before giving up. Default 50. */
  maxIters?: number;
  /** Convergence threshold on ||Δx||. Default 1e-7. */
  tol?: number;
  /** Initial Marquardt damping. Default 1e-3. */
  initLambda?: number;
  /** Forward-FD relative step size. Default 1e-6. */
  fdStep?: number;
};

export type LMResult = {
  /** The final variable vector. Caller is responsible for unpacking. */
  x: Float64Array;
  /** True if ||Δx|| < tol on some iteration. False if we hit maxIters. */
  converged: boolean;
  /** Number of iterations executed. */
  iters: number;
  /** ||r(x)|| at the final state. */
  residualNorm: number;
};

/**
 * Run Levenberg-Marquardt minimization of ||r(x)||² starting from x0.
 *
 * @param x0 Initial variable vector. Not mutated.
 * @param evaluate Returns the residual vector at the given variable
 *   vector. Length must be constant across calls.
 * @param normalize Optional mutator called after each accepted step to
 *   re-project x onto its constraint manifold (e.g., normalize
 *   quaternions in-place). Not called on rejected steps.
 * @param options
 */
export function runLM(
  x0: Float64Array,
  evaluate: (x: Float64Array) => Float64Array,
  normalize: ((x: Float64Array) => void) | null,
  options: LMOptions = {},
): LMResult {
  const maxIters = options.maxIters ?? 250;
  const tol = options.tol ?? 1e-9;
  // Smaller initial damping: first step is more Gauss-Newton-like, which
  // converges faster on well-conditioned problems (the typical case for
  // closed mate loops). Damping ramps up automatically on rejected steps.
  const initLambda = options.initLambda ?? 1e-5;
  const hRel = options.fdStep ?? 1e-6;

  const n = x0.length;
  const x = new Float64Array(x0);
  if (normalize) normalize(x);
  let r = evaluate(x);
  const m = r.length;
  let rNorm = vecNorm2(r);
  let lambda = initLambda;

  // Reusable buffers to avoid allocations in the hot loop.
  const J = new Float64Array(m * n);
  const JtJ = new Float64Array(n * n);
  const Jtr = new Float64Array(n);
  const rTrial = new Float64Array(m);
  const xTrial = new Float64Array(n);

  for (let iter = 0; iter < maxIters; iter++) {
    // Centered-FD Jacobian: J[k, j] = (r(x+h)[k] - r(x-h)[k]) / (2h).
    // 2× cost vs forward FD but better accuracy near zero (forward FD
    // gives only ~1 digit of meaningful gradient at our step sizes,
    // and closed mate loops have residuals that hover near 0 as LM
    // approaches closure). The extra digit is the difference between
    // "converged" and "stuck a few mm short".
    for (let j = 0; j < n; j++) {
      const h = hRel * Math.max(1, Math.abs(x[j]));
      const saved = x[j];
      x[j] = saved + h;
      const rPlus = new Float64Array(evaluate(x));
      x[j] = saved - h;
      const rMinus = evaluate(x);
      x[j] = saved;
      for (let k = 0; k < m; k++) {
        J[k * n + j] = (rPlus[k] - rMinus[k]) / (2 * h);
      }
    }

    // JᵀJ and Jᵀr.
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += J[k * n + i] * J[k * n + j];
        JtJ[i * n + j] = s;
        if (i !== j) JtJ[j * n + i] = s;
      }
      let s = 0;
      for (let k = 0; k < m; k++) s += J[k * n + i] * r[k];
      Jtr[i] = s;
    }

    // Inner damping retry: (JᵀJ + λI) is positive definite for λ > 0;
    // if Cholesky fails for some pathological Jacobian, escalate λ.
    let dx: Float64Array | null = null;
    let attempt = 0;
    while (attempt < 8 && !dx) {
      // (JᵀJ + λI). Adding to the diagonal in place; restored after solve.
      for (let i = 0; i < n; i++) JtJ[i * n + i] += lambda;
      const L = cholesky(JtJ, n);
      // Restore diagonal regardless of cholesky outcome.
      for (let i = 0; i < n; i++) JtJ[i * n + i] -= lambda;
      if (L) {
        dx = choleskyApply(L, Jtr, n);
        // Negate: we want -Jᵀr.
        for (let i = 0; i < n; i++) dx[i] = -dx[i];
      } else {
        lambda *= 10;
        attempt++;
      }
    }
    if (!dx) {
      // Pathological — return current state as not-converged.
      return { x, converged: false, iters: iter, residualNorm: Math.sqrt(rNorm) };
    }

    const dxNorm = vecNorm(dx);
    if (dxNorm < tol) {
      return { x, converged: true, iters: iter + 1, residualNorm: Math.sqrt(rNorm) };
    }

    // Trial step.
    for (let i = 0; i < n; i++) xTrial[i] = x[i] + dx[i];
    if (normalize) normalize(xTrial);
    const rNext = evaluate(xTrial);
    rTrial.set(rNext);
    const rTrialNorm = vecNorm2(rTrial);

    if (rTrialNorm < rNorm) {
      // Accept.
      x.set(xTrial);
      r = new Float64Array(rTrial);
      rNorm = rTrialNorm;
      lambda = Math.max(lambda / 2, 1e-12);
    } else {
      lambda *= 2;
      if (lambda > 1e12) {
        return { x, converged: false, iters: iter + 1, residualNorm: Math.sqrt(rNorm) };
      }
    }
  }

  return { x, converged: false, iters: maxIters, residualNorm: Math.sqrt(rNorm) };
}

/**
 * Cholesky factorization A = L Lᵀ for an n×n SPD matrix stored
 * row-major. Returns L (lower triangular, also row-major) or null if
 * A is not positive definite. Uses the Cholesky-Banachiewicz algorithm:
 * straightforward and numerically stable for small matrices.
 */
function cholesky(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= L[i * n + k] * L[j * n + k];
      }
      if (i === j) {
        if (sum <= 0) return null;
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
function choleskyApply(L: Float64Array, b: Float64Array, n: number): Float64Array {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
    z[i] = s / L[i * n + i];
  }
  const y = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * y[k];
    y[i] = s / L[i * n + i];
  }
  return y;
}

function vecNorm(v: Float64Array): number {
  return Math.sqrt(vecNorm2(v));
}

function vecNorm2(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
}
