import { describe, expect, it } from "vitest";
import { matrixRank, matrixRankWithPivots } from "../../solver-core/index.js";

describe("matrixRankWithPivots", () => {
  it("full-rank identity", () => {
    const A = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const { rank, pivots } = matrixRankWithPivots(A, 3, 3);
    expect(rank).toBe(3);
    expect([...pivots].sort()).toEqual([0, 1, 2]);
  });

  it("zero matrix has rank 0 and no pivots", () => {
    const { rank, pivots } = matrixRankWithPivots(new Float64Array(12), 3, 4);
    expect(rank).toBe(0);
    expect(pivots).toEqual([]);
  });

  it("empty matrix", () => {
    expect(matrixRankWithPivots(new Float64Array(0), 0, 0)).toEqual({ rank: 0, pivots: [] });
  });

  it("duplicated column drops rank and stays out of the pivot set", () => {
    // Columns: c0 = c2 = (1,0,0), c1 = (0,1,0).
    const A = new Float64Array([1, 0, 1, 0, 1, 0, 0, 0, 0]);
    const { rank, pivots } = matrixRankWithPivots(A, 3, 3);
    expect(rank).toBe(2);
    expect(pivots.length).toBe(2);
    // One of the duplicates is a pivot, the other is reported dependent.
    expect(pivots).toContain(1);
    expect(pivots.filter((p) => p === 0 || p === 2).length).toBe(1);
  });

  it("pivot order follows column norm, largest first", () => {
    // Column norms: c0 = 0.001, c1 = 100, c2 = 1 — all independent.
    const A = new Float64Array([0.001, 100, 1, 0, 0, 1, 0, 100, 0]);
    const { rank, pivots } = matrixRankWithPivots(A, 3, 3);
    expect(rank).toBe(3);
    expect(pivots[0]).toBe(1);
  });

  it("rank-1 outer product", () => {
    const u = [1, 2, 3, 4];
    const v = [2, -1, 0.5, 3];
    const A = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        A[i * 4 + j] = u[i] * v[j];
      }
    }
    const { rank, pivots } = matrixRankWithPivots(A, 4, 4);
    expect(rank).toBe(1);
    expect(pivots.length).toBe(1);
  });

  it("tall and wide shapes", () => {
    // 4×2 tall, independent columns.
    const tall = new Float64Array([1, 0, 0, 1, 1, 1, 2, -1]);
    expect(matrixRankWithPivots(tall, 4, 2).rank).toBe(2);
    // 2×4 wide, rank 2.
    const wide = new Float64Array([1, 0, 1, 2, 0, 1, 1, -1]);
    expect(matrixRankWithPivots(wide, 2, 4).rank).toBe(2);
  });

  it("redundant-row attribution via the transpose", () => {
    // Constraint Jacobian J (rows = constraints over 3 params):
    // row0 = (1, 0, 0), row1 = (0, 1, 0), row2 = row0 + row1.
    // Rank analysis runs on Jᵀ so pivots name independent ROWS;
    // the index missing from the pivot set is the redundant row.
    const J = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ];
    const m = 3;
    const n = 3;
    const Jt = new Float64Array(n * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        Jt[j * m + i] = J[i][j];
      }
    }
    const { rank, pivots } = matrixRankWithPivots(Jt, n, m);
    expect(rank).toBe(2);
    const redundant = [0, 1, 2].filter((row) => !pivots.includes(row));
    expect(redundant.length).toBe(1);
  });
});

describe("matrixRank", () => {
  it("agrees with matrixRankWithPivots", () => {
    const A = new Float64Array([1, 2, 3, 2, 4, 6, 1, 0, 1]);
    expect(matrixRank(A, 3, 3)).toBe(matrixRankWithPivots(A, 3, 3).rank);
    expect(matrixRank(A, 3, 3)).toBe(2);
  });

  it("does not mutate its input", () => {
    const A = new Float64Array([3, 1, 1, 3]);
    const copy = new Float64Array(A);
    matrixRank(A, 2, 2);
    expect(Array.from(A)).toEqual(Array.from(copy));
  });
});
