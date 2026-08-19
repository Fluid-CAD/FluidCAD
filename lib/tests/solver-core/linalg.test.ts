import { describe, expect, it } from "vitest";
import {
  cholesky,
  choleskySolve,
  vecInfNorm,
  vecNorm,
  vecNorm2,
} from "../../solver-core/index.js";

// Deterministic LCG so random-matrix tests are reproducible.
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("cholesky", () => {
  it("factors the identity to itself", () => {
    const n = 4;
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      A[i * n + i] = 1;
    }
    const L = cholesky(A, n);
    expect(L).not.toBeNull();
    expect(Array.from(L!)).toEqual(Array.from(A));
  });

  it("reproduces the known 3×3 factor", () => {
    // Classic example: A = L·Lᵀ with L = [[2,0,0],[6,1,0],[-8,5,3]].
    const A = new Float64Array([4, 12, -16, 12, 37, -43, -16, -43, 98]);
    const L = cholesky(A, 3);
    expect(L).not.toBeNull();
    const expected = [2, 0, 0, 6, 1, 0, -8, 5, 3];
    for (let i = 0; i < 9; i++) {
      expect(L![i]).toBeCloseTo(expected[i], 12);
    }
  });

  it("returns null for an indefinite matrix", () => {
    // Eigenvalues 3 and -1.
    const A = new Float64Array([1, 2, 2, 1]);
    expect(cholesky(A, 2)).toBeNull();
  });

  it("returns null for a singular matrix", () => {
    const A = new Float64Array([1, 1, 1, 1]);
    expect(cholesky(A, 2)).toBeNull();
  });

  it("returns null when the matrix contains NaN pivots", () => {
    // A NaN residual leaking into JᵀJ must fail the factorization
    // instead of producing a NaN factor that poisons the LM step.
    const A = new Float64Array([NaN, 0, 0, 1]);
    expect(cholesky(A, 2)).toBeNull();
  });
});

describe("choleskySolve", () => {
  it("solves a known SPD system", () => {
    const A = new Float64Array([4, 12, -16, 12, 37, -43, -16, -43, 98]);
    // b = A·[1, 2, 3]ᵀ
    const b = new Float64Array([4 + 24 - 48, 12 + 74 - 129, -16 - 86 + 294]);
    const L = cholesky(A, 3)!;
    const x = choleskySolve(L, b, 3);
    expect(x[0]).toBeCloseTo(1, 9);
    expect(x[1]).toBeCloseTo(2, 9);
    expect(x[2]).toBeCloseTo(3, 9);
  });

  it("solves random SPD systems to high accuracy", () => {
    const rand = makeLcg(42);
    for (let trial = 0; trial < 5; trial++) {
      const n = 6;
      // A = BᵀB + I is SPD.
      const B = new Float64Array(n * n);
      for (let i = 0; i < n * n; i++) {
        B[i] = rand() * 2 - 1;
      }
      const A = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          let s = i === j ? 1 : 0;
          for (let k = 0; k < n; k++) {
            s += B[k * n + i] * B[k * n + j];
          }
          A[i * n + j] = s;
        }
      }
      const xTrue = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        xTrue[i] = rand() * 10 - 5;
      }
      const b = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) {
          s += A[i * n + j] * xTrue[j];
        }
        b[i] = s;
      }
      const L = cholesky(A, n);
      expect(L).not.toBeNull();
      const x = choleskySolve(L!, b, n);
      for (let i = 0; i < n; i++) {
        expect(x[i]).toBeCloseTo(xTrue[i], 8);
      }
    }
  });
});

describe("vector norms", () => {
  it("computes 2-norm, squared norm, and ∞-norm", () => {
    const v = new Float64Array([3, -4]);
    expect(vecNorm(v)).toBeCloseTo(5, 12);
    expect(vecNorm2(v)).toBeCloseTo(25, 12);
    expect(vecInfNorm(v)).toBe(4);
  });

  it("∞-norm propagates NaN", () => {
    expect(vecInfNorm(new Float64Array([1, NaN, 3]))).toBeNaN();
  });

  it("handles empty vectors", () => {
    expect(vecNorm(new Float64Array(0))).toBe(0);
    expect(vecInfNorm(new Float64Array(0))).toBe(0);
  });
});
