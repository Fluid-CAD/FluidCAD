import { describe, expect, it } from "vitest";
import {
  cholesky,
  choleskyEnvelopeInto,
  choleskyEnvelopeSolveInto,
  choleskySolve,
  createSparseLMWorkspace,
  envelopeColumns,
  runLM,
  runLMSparse,
  type SparseStructure,
} from "../../solver-core/index.js";
import { buildSyntheticSketch, makeLcg, perturbedGuess, type SyntheticSystem } from "./synthetic.js";

// The envelope/sparse path is a pure restriction of the dense path to
// structural nonzeros, executed in the same summation order — so its
// results must be bit-identical to runLM/cholesky/choleskySolve, not
// merely close. That equivalence is the regression anchor for the
// whole P1 linear-solve rewrite.

/** Structural CSR pattern of a synthetic system's Jacobian, unioned
 * over a few generic probe points (a single point can have exact
 * zeros where the structure is nonzero). */
function csrFromProbes(sys: SyntheticSystem, seeds: number[]): SparseStructure {
  const { n, m } = sys;
  const mask = new Uint8Array(m * n);
  const J = new Float64Array(m * n);
  for (const seed of seeds) {
    J.fill(0);
    sys.jacobian(perturbedGuess(sys, 0.37, seed), J);
    for (let i = 0; i < m * n; i++) {
      if (J[i] !== 0) {
        mask[i] = 1;
      }
    }
  }
  const rowStart = new Int32Array(m + 1);
  const colsList: number[] = [];
  for (let k = 0; k < m; k++) {
    rowStart[k] = colsList.length;
    for (let j = 0; j < n; j++) {
      if (mask[k * n + j]) {
        colsList.push(j);
      }
    }
  }
  rowStart[m] = colsList.length;
  return { n, rowStart, cols: Int32Array.from(colsList) };
}

function denseAdapters(sys: SyntheticSystem, structure: SparseStructure) {
  const J = new Float64Array(sys.m * sys.n);
  return {
    evaluateInto: (x: Float64Array, r: Float64Array): void => {
      r.set(sys.evaluate(x));
    },
    jacobianInto: (x: Float64Array, vals: Float64Array): void => {
      J.fill(0);
      sys.jacobian(x, J);
      for (let k = 0; k < sys.m; k++) {
        for (let a = structure.rowStart[k]; a < structure.rowStart[k + 1]; a++) {
          vals[a] = J[k * sys.n + structure.cols[a]];
        }
      }
    },
  };
}

describe("envelope cholesky", () => {
  /** Random SPD matrix with a banded pattern: A = BᵀB + n·I. */
  function bandedSpd(n: number, band: number, seed: number): { A: Float64Array; firstNz: Int32Array } {
    const rand = makeLcg(seed);
    const A = new Float64Array(n * n);
    const B = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - band); j <= Math.min(n - 1, i + band); j++) {
        B[i * n + j] = rand() * 2 - 1;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = i === j ? n : 0;
        for (let k = 0; k < n; k++) {
          s += B[k * n + i] * B[k * n + j];
        }
        A[i * n + j] = s;
      }
    }
    const firstNz = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let f = i;
      for (let j = 0; j < i; j++) {
        if (A[i * n + j] !== 0) {
          f = j;
          break;
        }
      }
      firstNz[i] = f;
    }
    return { A, firstNz };
  }

  it("factor and solve are bit-identical to the dense routines", () => {
    const n = 40;
    const { A, firstNz } = bandedSpd(n, 4, 7);
    const denseL = cholesky(A, n);
    expect(denseL).not.toBeNull();
    const L = new Float64Array(n * n).fill(NaN); // stale garbage must be harmless
    expect(choleskyEnvelopeInto(A, n, firstNz, L)).toBe(true);
    for (let i = 0; i < n; i++) {
      for (let j = firstNz[i]; j <= i; j++) {
        expect(L[i * n + j]).toBe(denseL![i * n + j]);
      }
    }
    const rand = makeLcg(3);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      b[i] = rand() * 10 - 5;
    }
    const yDense = choleskySolve(denseL!, b, n);
    const cols = envelopeColumns(firstNz, n);
    const z = new Float64Array(n);
    const y = new Float64Array(n).fill(NaN);
    choleskyEnvelopeSolveInto(L, b, n, firstNz, cols, z, y);
    expect(Array.from(y)).toEqual(Array.from(yDense));
  });

  it("rejects a non-positive-definite matrix", () => {
    const n = 3;
    const A = new Float64Array([1, 0, 0, 0, -1, 0, 0, 0, 1]);
    const firstNz = new Int32Array([0, 1, 2]);
    expect(choleskyEnvelopeInto(A, n, firstNz, new Float64Array(n * n))).toBe(false);
  });
});

describe("runLMSparse", () => {
  it("matches dense runLM bit-for-bit on a synthetic sketch", () => {
    const sys = buildSyntheticSketch(30, 1);
    const structure = csrFromProbes(sys, [3, 17, 91]);
    const { evaluateInto, jacobianInto } = denseAdapters(sys, structure);
    const x0 = perturbedGuess(sys, 0.5, 11);
    const dense = runLM(x0, sys.evaluate, null, {
      jacobian: sys.jacobian,
      damping: "marquardt",
      residualStop: true,
    });
    const sparse = runLMSparse(x0, evaluateInto, jacobianInto, structure);
    expect(sparse.outcome).toBe("solved");
    expect(sparse.iters).toBe(dense.iters);
    expect(Array.from(sparse.x)).toEqual(Array.from(dense.x));
  });

  it("workspace reuse across solves changes nothing", () => {
    const sys = buildSyntheticSketch(10, 1);
    const structure = csrFromProbes(sys, [3, 17, 91]);
    const { evaluateInto, jacobianInto } = denseAdapters(sys, structure);
    const ws = createSparseLMWorkspace(structure);
    const fresh = runLMSparse(perturbedGuess(sys, 0.5, 5), evaluateInto, jacobianInto, structure);
    runLMSparse(perturbedGuess(sys, 0.5, 23), evaluateInto, jacobianInto, structure, {}, ws);
    const reused = runLMSparse(
      perturbedGuess(sys, 0.5, 5),
      evaluateInto,
      jacobianInto,
      structure,
      {},
      ws,
    );
    expect(Array.from(reused.x)).toEqual(Array.from(fresh.x));
    expect(reused.iters).toBe(fresh.iters);
  });

  it("rejects a workspace built for a different structure", () => {
    const sys = buildSyntheticSketch(10, 1);
    const a = csrFromProbes(sys, [3]);
    const b = csrFromProbes(sys, [3]);
    const ws = createSparseLMWorkspace(a);
    const { evaluateInto, jacobianInto } = denseAdapters(sys, b);
    expect(() =>
      runLMSparse(perturbedGuess(sys, 0.1, 1), evaluateInto, jacobianInto, b, {}, ws),
    ).toThrow(/different structure/);
  });

  it("residualRows: an unreachable trailing drag row does not fail the verdict", () => {
    // One variable, one hard row (x - 2), one soft unreachable drag
    // row 0.1·(x - 100). The LS optimum sits ~2.97; the hard row can
    // never reach 1e-8 with the drag row present under the *full*
    // verdict, but the prefix verdict must not care about the drag row.
    const structure: SparseStructure = {
      n: 1,
      rowStart: new Int32Array([0, 1, 2]),
      cols: new Int32Array([0, 0]),
    };
    const evaluateInto = (x: Float64Array, r: Float64Array): void => {
      r[0] = x[0] - 2;
      r[1] = 0.1 * (x[0] - 100);
    };
    const jacobianInto = (_x: Float64Array, vals: Float64Array): void => {
      vals[0] = 1;
      vals[1] = 0.1;
    };
    const full = runLMSparse(new Float64Array([0]), evaluateInto, jacobianInto, structure, {
      tol: 1e-12,
    });
    expect(full.outcome).toBe("didnt-converge");
    const prefix = runLMSparse(new Float64Array([0]), evaluateInto, jacobianInto, structure, {
      tol: 1e-12,
      residualRows: 1,
    });
    expect(prefix.outcome).toBe("didnt-converge"); // hard row is off its target at the LS optimum
    // With a *reachable* prefix (hard row satisfied at the optimum the
    // drag row also wants), the verdict is solved even though the drag
    // row is what the ∞-norm would flag.
    const evaluateInto2 = (x: Float64Array, r: Float64Array): void => {
      r[0] = 0; // no hard constraint
      r[1] = 0.1 * (x[0] - 100);
    };
    const jacobianInto2 = (_x: Float64Array, vals: Float64Array): void => {
      vals[0] = 0;
      vals[1] = 0.1;
    };
    const soft = runLMSparse(new Float64Array([0]), evaluateInto2, jacobianInto2, structure, {
      residualRows: 1,
    });
    expect(soft.outcome).toBe("solved");
    expect(soft.residualInfNorm).toBe(0);
  });

  it("reports lambda and fixed-point-skips a warm restart", () => {
    const sys = buildSyntheticSketch(10, 1);
    const structure = csrFromProbes(sys, [3, 17, 91]);
    const { evaluateInto, jacobianInto } = denseAdapters(sys, structure);
    const first = runLMSparse(perturbedGuess(sys, 0.3, 9), evaluateInto, jacobianInto, structure);
    expect(first.outcome).toBe("solved");
    expect(Number.isFinite(first.lambda)).toBe(true);
    const warm = runLMSparse(first.x, evaluateInto, jacobianInto, structure, {
      initLambda: first.lambda,
    });
    expect(warm.iters).toBe(0);
    expect(warm.outcome).toBe("solved");
  });

  it("a NaN residual ends singular, not hung", () => {
    const structure: SparseStructure = {
      n: 1,
      rowStart: new Int32Array([0, 1]),
      cols: new Int32Array([0]),
    };
    const result = runLMSparse(
      new Float64Array([1]),
      (_x, r) => {
        r[0] = NaN;
      },
      (_x, vals) => {
        vals[0] = NaN;
      },
      structure,
    );
    expect(result.outcome).toBe("singular");
  });

  it("a variable touched by no row stays at its guess", () => {
    const structure: SparseStructure = {
      n: 2,
      rowStart: new Int32Array([0, 1]),
      cols: new Int32Array([0]),
    };
    const result = runLMSparse(
      new Float64Array([5, 42]),
      (x, r) => {
        r[0] = x[0] - 1;
      },
      (_x, vals) => {
        vals[0] = 1;
      },
      structure,
    );
    expect(result.outcome).toBe("solved");
    expect(result.x[0]).toBeCloseTo(1, 9);
    expect(result.x[1]).toBe(42);
  });
});
