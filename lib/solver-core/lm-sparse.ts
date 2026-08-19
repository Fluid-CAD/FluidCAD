// Sparse-row Levenberg-Marquardt driver for the 2D sketch solver.
//
// Part of lib/solver-core/ — see linalg.ts for the no-imports rule.
//
// Same algorithm as runLM (lm.ts), specialized for the sketch
// engine's profile, where the P0 benchmark showed dense O(n²)/O(n³)
// per-iteration work blowing the 2 ms warm-drag budget at ~550
// params:
//
//  - The Jacobian's sparsity pattern is fixed across iterations and
//    supplied up front (SparseStructure, CSR-style). Rows have ≤ 8
//    nonzeros, so JᵀJ/Jᵀr accumulation is O(Σk²), and only envelope
//    entries of JᵀJ are ever touched — no O(m·n) buffer fills.
//  - The linear solve is envelope (skyline) Cholesky: O(n·b²) for
//    bandwidth b under the caller's param ordering
//    (lib/sketch-solver runs reverse Cuthill-McKee), vs O(n³/6)
//    dense. Where both paths compute, the flops run in the dense
//    summation order, so results match runLM bit-for-bit.
//  - All large buffers live in a reusable workspace so a 60 fps drag
//    loop allocates nothing per frame.
//  - `residualRows` lets drag callers append soft target rows that
//    participate in the minimization but not in the solved/conflict
//    verdict: an unreachable drag target must not read as a
//    constraint failure.
//  - The final λ is reported so warm drag loops can hand it to the
//    next frame (options.initLambda) instead of re-ramping.
//
// Defaults differ from runLM deliberately: this driver has no legacy
// callers, so `damping: 'marquardt'` and `residualStop: true` — the
// options every sketch solve wants — are the defaults here.

import {
  choleskyEnvelopeInto,
  choleskyEnvelopeSolveInto,
  envelopeColumns,
  vecNorm,
  vecNorm2,
} from './linalg.js';
import type { EnvelopeColumns } from './linalg.js';
import type { LMOutcome } from './lm.js';

export type SparseStructure = {
  /** Number of variables (columns). */
  n: number;
  /** CSR row offsets, length m+1. */
  rowStart: Int32Array;
  /** Column indices per row, strictly ascending within each row. */
  cols: Int32Array;
};

export type SparseLMOptions = {
  /** Maximum LM iterations before giving up. Default 250. */
  maxIters?: number;
  /** Convergence threshold on ‖Δx‖. Default 1e-9. */
  tol?: number;
  /** Success threshold on the residual ∞-norm. Default 1e-8. */
  residualTol?: number;
  /** Initial Marquardt damping. Default 1e-5. Warm drag loops pass
   * the previous frame's result.lambda here. */
  initLambda?: number;
  /** Stop as soon as ‖r‖∞ < residualTol (all rows, drag rows
   * included — a satisfied drag row means the target is reached).
   * Default true. */
  residualStop?: boolean;
  /** Damping matrix, as in runLM. Default 'marquardt'. */
  damping?: 'identity' | 'marquardt';
  /**
   * Relative floor for the Marquardt column-equilibration scale:
   * columns whose JᵀJ diagonal falls below maxDiag·scaleFloorRel are
   * damped as if they sat at the floor. Default 1e-6 — much harder
   * than runLM's 1e-12, deliberately: sketch params are all length
   * units, so genuine column-norm spread is small, while a
   * *collapsed* column (an under-constrained direction passing
   * through an axis-aligned pose — e.g. a free arc endpoint) must
   * not be inflated into thousand-unit trial steps that reject
   * until λ explodes (the classic naive-Marquardt stall).
   */
  scaleFloorRel?: number;
  /**
   * Relative-progress stop: after an accepted step, stop when the
   * relative decrease of ‖r‖² is ≤ ftol. Default 0 (disabled). Drag
   * passes pass a loose value (~1e-6) so an unreachable target's
   * nonzero-residual optimum doesn't limit-cycle to maxIters.
   */
  ftol?: number;
  /**
   * Number of leading rows whose ∞-norm decides the solved verdict
   * (`outcome`). Defaults to all rows. Drag callers order their rows
   * [constraints..., drag targets...] and pass the constraint count,
   * so an unreachable drag target still reports 'solved' when every
   * constraint holds. The residualStop early-exit always tests the
   * full vector — stopping on satisfied constraints alone would
   * freeze a drag before the target row had pulled anything.
   */
  residualRows?: number;
};

export type SparseLMResult = {
  x: Float64Array;
  /** Legacy step test: true if ‖Δx‖ < tol fired. */
  converged: boolean;
  /** Residual verdict over the first residualRows rows. */
  outcome: LMOutcome;
  iters: number;
  /** ‖r‖₂ over all rows at the final state. */
  residualNorm: number;
  /** ‖r‖∞ over the first residualRows rows at the final state. */
  residualInfNorm: number;
  /** Final damping — feed to the next warm solve's initLambda. */
  lambda: number;
};

/**
 * Reusable buffers for runLMSparse. Create once per structure (the
 * sketch engine caches one per component) and pass to every solve;
 * the driver validates that the workspace belongs to the structure.
 */
export type SparseLMWorkspace = {
  structure: SparseStructure;
  m: number;
  /** Envelope of JᵀJ implied by the row pattern. */
  firstNz: Int32Array;
  envCols: EnvelopeColumns;
  vals: Float64Array;
  r: Float64Array;
  rTrial: Float64Array;
  x: Float64Array;
  xTrial: Float64Array;
  dx: Float64Array;
  z: Float64Array;
  JtJ: Float64Array;
  Ahat: Float64Array;
  L: Float64Array;
  Jtr: Float64Array;
  bhat: Float64Array;
  colScale: Float64Array;
};

export function createSparseLMWorkspace(structure: SparseStructure): SparseLMWorkspace {
  const n = structure.n;
  const m = structure.rowStart.length - 1;
  const firstNz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    firstNz[i] = i;
  }
  for (let k = 0; k < m; k++) {
    const s0 = structure.rowStart[k];
    const s1 = structure.rowStart[k + 1];
    if (s0 === s1) {
      continue;
    }
    const f = structure.cols[s0];
    for (let a = s0; a < s1; a++) {
      const i = structure.cols[a];
      if (f < firstNz[i]) {
        firstNz[i] = f;
      }
    }
  }
  return {
    structure,
    m,
    firstNz,
    envCols: envelopeColumns(firstNz, n),
    vals: new Float64Array(structure.cols.length),
    r: new Float64Array(m),
    rTrial: new Float64Array(m),
    x: new Float64Array(n),
    xTrial: new Float64Array(n),
    dx: new Float64Array(n),
    z: new Float64Array(n),
    JtJ: new Float64Array(n * n),
    Ahat: new Float64Array(n * n),
    L: new Float64Array(n * n),
    Jtr: new Float64Array(n),
    bhat: new Float64Array(n),
    colScale: new Float64Array(n),
  };
}

function infNormPrefix(v: Float64Array, count: number): number {
  let s = 0;
  for (let i = 0; i < count; i++) {
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

/**
 * Minimize ‖r(x)‖² with a fixed-sparsity analytic Jacobian.
 *
 * @param x0 Initial variables. Not mutated.
 * @param evaluateInto Writes the m residuals for x into the provided
 *   buffer.
 * @param jacobianInto Writes the Jacobian values for x into the
 *   provided buffer, matching `structure.cols` slot-for-slot. The
 *   buffer is pre-zeroed each iteration; every structural slot should
 *   be written (a skipped slot reads as an exact zero).
 * @param structure Fixed CSR sparsity pattern of the Jacobian.
 * @param options See SparseLMOptions — note the sketch-profile
 *   defaults (marquardt damping, residualStop on).
 * @param workspace Optional reusable buffers from
 *   createSparseLMWorkspace; allocated fresh when omitted.
 */
export function runLMSparse(
  x0: Float64Array,
  evaluateInto: (x: Float64Array, r: Float64Array) => void,
  jacobianInto: (x: Float64Array, vals: Float64Array) => void,
  structure: SparseStructure,
  options: SparseLMOptions = {},
  workspace?: SparseLMWorkspace,
): SparseLMResult {
  const n = structure.n;
  if (x0.length !== n) {
    throw new Error(`runLMSparse: x0 length ${x0.length} != structure.n ${n}`);
  }
  const ws = workspace ?? createSparseLMWorkspace(structure);
  if (ws.structure !== structure) {
    throw new Error('runLMSparse: workspace was built for a different structure');
  }
  const m = ws.m;
  const maxIters = options.maxIters ?? 250;
  const tol = options.tol ?? 1e-9;
  const residualTol = options.residualTol ?? 1e-8;
  const marquardt = (options.damping ?? 'marquardt') === 'marquardt';
  const scaleFloorRel = options.scaleFloorRel ?? 1e-6;
  const ftol = options.ftol ?? 0;
  const residualStop = options.residualStop ?? true;
  const residualRows = options.residualRows ?? m;
  let lambda = options.initLambda ?? 1e-5;

  const { firstNz, envCols, vals, r, rTrial, x, xTrial, dx, z, JtJ, Ahat, L, Jtr, bhat, colScale } =
    ws;
  const { rowStart, cols } = structure;

  x.set(x0);
  evaluateInto(x, r);
  let rNorm = vecNorm2(r);

  const finish = (converged: boolean, iters: number, singular = false): SparseLMResult => {
    const residualInfNorm = infNormPrefix(r, residualRows);
    const outcome: LMOutcome =
      residualInfNorm < residualTol ? 'solved' : singular ? 'singular' : 'didnt-converge';
    return {
      x,
      converged,
      outcome,
      iters,
      residualNorm: Math.sqrt(rNorm),
      residualInfNorm,
      lambda,
    };
  };

  if (residualStop && infNormPrefix(r, m) < residualTol) {
    return finish(true, 0);
  }

  for (let iter = 0; iter < maxIters; iter++) {
    vals.fill(0);
    jacobianInto(x, vals);

    // JᵀJ (lower triangle, envelope entries only) and Jᵀr. Same
    // per-entry k-ascending summation order as the dense driver's
    // sparse-row gather, so the matrix is bit-identical to runLM's.
    for (let i = 0; i < n; i++) {
      const rowI = i * n;
      for (let j = firstNz[i]; j <= i; j++) {
        JtJ[rowI + j] = 0;
      }
      Jtr[i] = 0;
    }
    for (let k = 0; k < m; k++) {
      const s0 = rowStart[k];
      const s1 = rowStart[k + 1];
      const rk = r[k];
      for (let a = s0; a < s1; a++) {
        const i = cols[a];
        const va = vals[a];
        Jtr[i] += va * rk;
        for (let b = a; b < s1; b++) {
          JtJ[cols[b] * n + i] += va * vals[b];
        }
      }
    }

    if (marquardt) {
      let maxDiag = 0;
      for (let jj = 0; jj < n; jj++) {
        const d = JtJ[jj * n + jj];
        if (d > maxDiag) {
          maxDiag = d;
        }
      }
      const floor = maxDiag > 0 ? maxDiag * scaleFloorRel : 1;
      for (let jj = 0; jj < n; jj++) {
        colScale[jj] = 1 / Math.sqrt(Math.max(JtJ[jj * n + jj], floor));
      }
      for (let i = 0; i < n; i++) {
        const si = colScale[i];
        const rowI = i * n;
        bhat[i] = Jtr[i] * si;
        for (let j = firstNz[i]; j <= i; j++) {
          Ahat[rowI + j] = JtJ[rowI + j] * si * colScale[j];
        }
      }
    }
    const A = marquardt ? Ahat : JtJ;
    const b = marquardt ? bhat : Jtr;

    // Inner damping retry, as in runLM.
    let solved = false;
    let attempt = 0;
    while (attempt < 8 && !solved) {
      for (let i = 0; i < n; i++) {
        A[i * n + i] += lambda;
      }
      const ok = choleskyEnvelopeInto(A, n, firstNz, L);
      for (let i = 0; i < n; i++) {
        A[i * n + i] -= lambda;
      }
      if (ok) {
        choleskyEnvelopeSolveInto(L, b, n, firstNz, envCols, z, dx);
        if (marquardt) {
          for (let i = 0; i < n; i++) {
            dx[i] = -dx[i] * colScale[i];
          }
        } else {
          for (let i = 0; i < n; i++) {
            dx[i] = -dx[i];
          }
        }
        solved = true;
      } else {
        lambda *= 10;
        attempt++;
      }
    }
    if (!solved) {
      return finish(false, iter, true);
    }

    const dxNorm = vecNorm(dx);
    if (dxNorm < tol) {
      return finish(true, iter + 1);
    }

    for (let i = 0; i < n; i++) {
      xTrial[i] = x[i] + dx[i];
    }
    evaluateInto(xTrial, rTrial);
    const rTrialNorm = vecNorm2(rTrial);

    if (rTrialNorm < rNorm) {
      const previous = rNorm;
      x.set(xTrial);
      r.set(rTrial);
      rNorm = rTrialNorm;
      lambda = Math.max(lambda / 2, 1e-12);
      if (residualStop && infNormPrefix(r, m) < residualTol) {
        return finish(true, iter + 1);
      }
      if (ftol > 0 && previous - rNorm <= ftol * previous) {
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
