// Levenberg-Marquardt least-squares driver.
//
// Part of lib/solver-core/ — the dependency-free numeric core shared by
// the assembly solver's closed-loop relaxation pass (via the
// ui/src/solver/relaxation.ts re-export) and the 2D sketch constraint
// solver. See linalg.ts for the no-imports rule.
//
// Implementation is hand-rolled to keep the dep graph clean. Assembly
// problems are small (typically 4 bodies × 7 params = 28 variables,
// ~25 residuals); sketch problems reach a few hundred params, where the
// analytic-Jacobian option and the sparse-row JᵀJ accumulation below
// carry the cost.
//
// Algorithm (Gauss-Newton with Marquardt damping):
//   1. r ← evaluate(x); rNorm ← ‖r‖²
//   2. J ← `options.jacobian` if supplied, else centered-FD.
//   3. Solve (JᵀJ + λD) Δx = -Jᵀr via Cholesky, where D = I
//      (damping: 'identity', the legacy assembly behavior) or
//      D = diag(JᵀJ) applied through column equilibration
//      (damping: 'marquardt' — scale-invariant, for systems mixing
//      units such as mm and radians).
//   4. Try x_new = x + Δx; if ‖r(x_new)‖² < ‖r(x)‖², accept and
//      halve λ; else reject and double λ.
//   5. After each accepted step, call `normalize(x)` so the caller can
//      re-project x onto its constraint manifold (e.g., normalize
//      quaternions in-place). Not called on rejected steps.
//   6. Stop on ‖Δx‖ < tol or maxIters. `converged` reports the step
//      test (legacy); `outcome` reports the ‖r‖∞ < residualTol success
//      test, independent of why iteration stopped.
//
// The centered-FD step size for each variable is `h_rel·max(1, |x_j|)`
// with `h_rel = 1e-6`. Centered FD costs 2n evaluations per iteration —
// fine at assembly sizes, ruinous at sketch sizes; sketch callers must
// supply `jacobian`.

import { cholesky, choleskySolve, vecInfNorm, vecNorm, vecNorm2 } from './linalg.js';

export type LMOutcome =
  /** ‖r‖∞ < residualTol at the final state — the system is satisfied. */
  | 'solved'
  /** Iteration stopped (step tolerance, maxIters, or λ blowup) with the
   * residual still above residualTol — under a least-squares reading,
   * conflicting constraints land here. */
  | 'didnt-converge'
  /** The damped normal matrix could not be factored even after λ
   * escalation (NaN/degenerate Jacobian). x is the last accepted state. */
  | 'singular';

export type LMOptions = {
  /** Maximum LM iterations before giving up. Default 250. */
  maxIters?: number;
  /** Convergence threshold on ‖Δx‖. Default 1e-9. */
  tol?: number;
  /** Success threshold on ‖r‖∞ for the `outcome` report. Default 1e-8. */
  residualTol?: number;
  /** Initial Marquardt damping. Default 1e-5: the first step is more
   * Gauss-Newton-like, which converges faster on well-conditioned
   * problems; damping ramps up automatically on rejected steps. */
  initLambda?: number;
  /** Centered-FD relative step size. Default 1e-6. */
  fdStep?: number;
  /**
   * Analytic Jacobian supplier. Called once per iteration with the
   * current x and the m×n row-major J buffer. J is pre-zeroed — write
   * only the nonzero entries. When omitted, a centered-FD Jacobian is
   * computed (2n residual evaluations per iteration).
   */
  jacobian?: (x: Float64Array, J: Float64Array) => void;
  /**
   * When true, iteration stops as soon as ‖r‖∞ < residualTol — after
   * any accepted step, or immediately at iteration 0 for a warm start
   * already on the solution (the sketch solver's fixed-point skip).
   * Default false: the legacy assembly behavior keeps polishing until
   * the ‖Δx‖ step test fires, which can burn tens of Cholesky solves
   * after the system is already satisfied.
   */
  residualStop?: boolean;
  /**
   * Damping matrix D in (JᵀJ + λD)Δx = -Jᵀr. 'identity' (default) is
   * the legacy assembly behavior. 'marquardt' equilibrates columns of J
   * to unit norm and damps with λI in the scaled space — algebraically
   * λ·diag(JᵀJ) in the original space — so the step is invariant to
   * per-variable units. Near-zero columns are floored at 1e-12 of the
   * largest diagonal so rank-deficient directions stay damped.
   */
  damping?: 'identity' | 'marquardt';
};

export type LMResult = {
  /** The final variable vector. Caller is responsible for unpacking. */
  x: Float64Array;
  /** True if ‖Δx‖ < tol on some iteration. False if we hit maxIters.
   * Legacy step test — `outcome` is the residual-based verdict. */
  converged: boolean;
  /** Residual-based verdict; see LMOutcome. */
  outcome: LMOutcome;
  /** Number of iterations executed. */
  iters: number;
  /** ‖r(x)‖₂ at the final state. */
  residualNorm: number;
  /** ‖r(x)‖∞ at the final state. */
  residualInfNorm: number;
};

/**
 * Compute the centered-FD Jacobian of `evaluate` at x into the m×n
 * row-major buffer J: J[k, j] = (r(x+h)[k] - r(x-h)[k]) / (2h) with
 * h = hRel·max(1, |x_j|). x is probed in place and restored. Centered
 * FD costs 2× forward FD but keeps meaningful digits when residuals
 * hover near zero — the difference between "converged" and "stuck a
 * few mm short". Exported so constraint implementations can cross-check
 * analytic Jacobians in tests.
 */
export function fdJacobian(
  evaluate: (x: Float64Array) => Float64Array,
  x: Float64Array,
  m: number,
  J: Float64Array,
  hRel = 1e-6,
): void {
  const n = x.length;
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
}

/**
 * Run Levenberg-Marquardt minimization of ‖r(x)‖² starting from x0.
 *
 * @param x0 Initial variable vector. Not mutated.
 * @param evaluate Returns the residual vector at the given variable
 *   vector. Length must be constant across calls. The returned array is
 *   copied — evaluate may reuse an internal buffer.
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
  const residualTol = options.residualTol ?? 1e-8;
  const initLambda = options.initLambda ?? 1e-5;
  const hRel = options.fdStep ?? 1e-6;
  const jacobian = options.jacobian ?? null;
  const marquardt = options.damping === 'marquardt';
  const residualStop = options.residualStop ?? false;

  const n = x0.length;
  const x = new Float64Array(x0);
  if (normalize) {
    normalize(x);
  }
  const r = new Float64Array(evaluate(x));
  const m = r.length;
  let rNorm = vecNorm2(r);
  let lambda = initLambda;

  const finish = (converged: boolean, iters: number, singular = false): LMResult => {
    const residualInfNorm = vecInfNorm(r);
    const outcome: LMOutcome =
      residualInfNorm < residualTol ? 'solved' : singular ? 'singular' : 'didnt-converge';
    return {
      x,
      converged,
      outcome,
      iters,
      residualNorm: Math.sqrt(rNorm),
      residualInfNorm,
    };
  };

  if (residualStop && vecInfNorm(r) < residualTol) {
    return finish(true, 0);
  }

  // Reusable buffers to avoid allocations in the hot loop.
  const J = new Float64Array(m * n);
  const JtJ = new Float64Array(n * n);
  const Jtr = new Float64Array(n);
  const rTrial = new Float64Array(m);
  const xTrial = new Float64Array(n);
  const nzIdx = new Int32Array(n);
  // Marquardt-mode scratch: equilibrated normal matrix + rhs + scales.
  const Ahat = marquardt ? new Float64Array(n * n) : null;
  const bhat = marquardt ? new Float64Array(n) : null;
  const colScale = marquardt ? new Float64Array(n) : null;

  for (let iter = 0; iter < maxIters; iter++) {
    if (jacobian) {
      J.fill(0);
      jacobian(x, J);
    } else {
      fdJacobian(evaluate, x, m, J, hRel);
    }

    // JᵀJ and Jᵀr, accumulated row-wise over each row's nonzeros.
    // Analytic sketch Jacobians have ≤ 8 nonzeros per row, so this is
    // O(m·k²) instead of O(m·n²); for dense rows it degenerates to the
    // plain triple loop with the same k-ascending summation order, so
    // results are bit-identical to the dense formulation.
    JtJ.fill(0);
    Jtr.fill(0);
    for (let k = 0; k < m; k++) {
      const base = k * n;
      let nnz = 0;
      for (let j = 0; j < n; j++) {
        if (J[base + j] !== 0) {
          nzIdx[nnz++] = j;
        }
      }
      const rk = r[k];
      for (let a = 0; a < nnz; a++) {
        const i = nzIdx[a];
        const Jki = J[base + i];
        Jtr[i] += Jki * rk;
        const row = i * n;
        for (let b = a; b < nnz; b++) {
          const j = nzIdx[b];
          JtJ[row + j] += Jki * J[base + j];
        }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        JtJ[j * n + i] = JtJ[i * n + j];
      }
    }

    // Marquardt mode: equilibrate columns to unit norm. diag(JᵀJ) is
    // exactly the squared column norms, so no extra pass over J.
    if (marquardt) {
      let maxDiag = 0;
      for (let jj = 0; jj < n; jj++) {
        const d = JtJ[jj * n + jj];
        if (d > maxDiag) {
          maxDiag = d;
        }
      }
      const floor = maxDiag > 0 ? maxDiag * 1e-12 : 1;
      for (let jj = 0; jj < n; jj++) {
        colScale[jj] = 1 / Math.sqrt(Math.max(JtJ[jj * n + jj], floor));
      }
      for (let i = 0; i < n; i++) {
        const si = colScale[i];
        bhat[i] = Jtr[i] * si;
        for (let j = 0; j < n; j++) {
          Ahat[i * n + j] = JtJ[i * n + j] * si * colScale[j];
        }
      }
    }
    const A = marquardt ? Ahat : JtJ;
    const b = marquardt ? bhat : Jtr;

    // Inner damping retry: (A + λI) is positive definite for λ > 0;
    // if Cholesky fails for some pathological Jacobian, escalate λ.
    let dx: Float64Array | null = null;
    let attempt = 0;
    while (attempt < 8 && !dx) {
      // (A + λI). Adding to the diagonal in place; restored after solve.
      for (let i = 0; i < n; i++) {
        A[i * n + i] += lambda;
      }
      const L = cholesky(A, n);
      // Restore diagonal regardless of cholesky outcome.
      for (let i = 0; i < n; i++) {
        A[i * n + i] -= lambda;
      }
      if (L) {
        dx = choleskySolve(L, b, n);
        // Negate (we want -Jᵀr); un-equilibrate in the same pass.
        if (marquardt) {
          for (let i = 0; i < n; i++) {
            dx[i] = -dx[i] * colScale[i];
          }
        } else {
          for (let i = 0; i < n; i++) {
            dx[i] = -dx[i];
          }
        }
      } else {
        lambda *= 10;
        attempt++;
      }
    }
    if (!dx) {
      // Pathological — return current state as not-converged.
      return finish(false, iter, true);
    }

    const dxNorm = vecNorm(dx);
    if (dxNorm < tol) {
      return finish(true, iter + 1);
    }

    // Trial step.
    for (let i = 0; i < n; i++) {
      xTrial[i] = x[i] + dx[i];
    }
    if (normalize) {
      normalize(xTrial);
    }
    rTrial.set(evaluate(xTrial));
    const rTrialNorm = vecNorm2(rTrial);

    if (rTrialNorm < rNorm) {
      // Accept.
      x.set(xTrial);
      r.set(rTrial);
      rNorm = rTrialNorm;
      lambda = Math.max(lambda / 2, 1e-12);
      if (residualStop && vecInfNorm(r) < residualTol) {
        return finish(true, iter + 1);
      }
    } else {
      lambda *= 2;
      if (lambda > 1e12) {
        return finish(false, iter + 1);
      }
    }
  }

  return finish(false, maxIters);
}
