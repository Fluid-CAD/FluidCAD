import { describe, expect, it } from "vitest";
import { fdJacobian, runLM, type LMResult } from "../../solver-core/index.js";

// Two circles of radius 5 centered at (0,0) and (6,0); intersections
// at (3, ±4). Distance residuals — mm-scale, nonlinear, two solution
// branches. The workhorse fixture for branch and determinism tests.
const circles = (x: Float64Array): Float64Array =>
  new Float64Array([
    Math.hypot(x[0], x[1]) - 5,
    Math.hypot(x[0] - 6, x[1]) - 5,
  ]);

describe("runLM", () => {
  it("solves a consistent overdetermined linear system exactly", () => {
    const evaluate = (x: Float64Array) =>
      new Float64Array([x[0] - 1, x[1] - 2, x[0] + x[1] - 3]);
    const result = runLM(new Float64Array([10, -7]), evaluate, null);
    expect(result.converged).toBe(true);
    expect(result.outcome).toBe("solved");
    expect(result.x[0]).toBeCloseTo(1, 8);
    expect(result.x[1]).toBeCloseTo(2, 8);
    expect(result.residualInfNorm).toBeLessThan(1e-8);
  });

  it("guess proximity picks the solution branch", () => {
    const upper = runLM(new Float64Array([3, 3.5]), circles, null);
    expect(upper.outcome).toBe("solved");
    expect(upper.x[0]).toBeCloseTo(3, 6);
    expect(upper.x[1]).toBeCloseTo(4, 6);

    const lower = runLM(new Float64Array([3, -3.5]), circles, null);
    expect(lower.outcome).toBe("solved");
    expect(lower.x[1]).toBeCloseTo(-4, 6);
  });

  it("under-determined system converges to the solution nearest the guess", () => {
    // One residual, two params: x + y = 2 from (0,0). The damped
    // normal equations give the minimum-norm step, so the answer is
    // the projection (1,1) — the SolveSpace semantics the sketch
    // solver relies on for under-constrained geometry.
    const evaluate = (x: Float64Array) => new Float64Array([x[0] + x[1] - 2]);
    const result = runLM(new Float64Array([0, 0]), evaluate, null);
    expect(result.outcome).toBe("solved");
    expect(result.x[0]).toBeCloseTo(1, 4);
    expect(result.x[1]).toBeCloseTo(1, 4);
  });

  it("reports didnt-converge for contradictory residuals (converged step, bad residual)", () => {
    // x = 1 and x = 2 can't both hold; LM settles at the least-squares
    // compromise 1.5. The legacy `converged` step test passes — the
    // exact gap `outcome` exists to close.
    const evaluate = (x: Float64Array) => new Float64Array([x[0] - 1, x[0] - 2]);
    const result = runLM(new Float64Array([0]), evaluate, null);
    expect(result.x[0]).toBeCloseTo(1.5, 6);
    expect(result.converged).toBe(true);
    expect(result.outcome).toBe("didnt-converge");
    expect(result.residualInfNorm).toBeCloseTo(0.5, 6);
  });

  it("reports didnt-converge when the residual is flat", () => {
    const evaluate = () => new Float64Array([1]);
    const result = runLM(new Float64Array([0, 0]), evaluate, null);
    expect(result.converged).toBe(true);
    expect(result.outcome).toBe("didnt-converge");
    expect(result.residualInfNorm).toBeCloseTo(1, 12);
  });

  it("reports singular when the residual is NaN", () => {
    const evaluate = () => new Float64Array([NaN]);
    const result = runLM(new Float64Array([0]), evaluate, null);
    expect(result.outcome).toBe("singular");
    expect(result.converged).toBe(false);
    expect(Number.isFinite(result.residualNorm)).toBe(false);
  });

  it("analytic Jacobian matches the FD path and receives a pre-zeroed buffer", () => {
    let calls = 0;
    const jacobian = (x: Float64Array, J: Float64Array) => {
      calls++;
      for (let i = 0; i < J.length; i++) {
        expect(J[i]).toBe(0);
      }
      const d0 = Math.hypot(x[0], x[1]);
      const d1 = Math.hypot(x[0] - 6, x[1]);
      // Row-major 2×2.
      J[0] = x[0] / d0;
      J[1] = x[1] / d0;
      J[2] = (x[0] - 6) / d1;
      J[3] = x[1] / d1;
    };
    const analytic = runLM(new Float64Array([3, 3.5]), circles, null, { jacobian });
    const fd = runLM(new Float64Array([3, 3.5]), circles, null);
    expect(calls).toBeGreaterThan(0);
    expect(analytic.outcome).toBe("solved");
    expect(analytic.x[0]).toBeCloseTo(fd.x[0], 6);
    expect(analytic.x[1]).toBeCloseTo(fd.x[1], 6);
  });

  it("marquardt damping survives unit mixing that stalls identity damping", () => {
    // Column scales differ by 10⁶ (a mm-ish param next to a
    // radian-ish param). With a large λ, identity damping crushes the
    // weak column's step to nothing; Marquardt damping is
    // scale-invariant and converges.
    const evaluate = (x: Float64Array) =>
      new Float64Array([1e3 * (x[0] - 2), 1e-3 * (x[1] - 3)]);
    const opts = { initLambda: 1, maxIters: 15 };
    const identity = runLM(new Float64Array([0, 0]), evaluate, null, opts);
    const marquardt = runLM(new Float64Array([0, 0]), evaluate, null, {
      ...opts,
      damping: "marquardt",
    });
    expect(identity.outcome).not.toBe("solved");
    expect(marquardt.outcome).toBe("solved");
    expect(marquardt.x[0]).toBeCloseTo(2, 6);
    expect(marquardt.x[1]).toBeCloseTo(3, 4);
  });

  it("marquardt damping agrees with identity on a well-scaled problem", () => {
    const identity = runLM(new Float64Array([3, 3.5]), circles, null);
    const marquardt = runLM(new Float64Array([3, 3.5]), circles, null, {
      damping: "marquardt",
    });
    expect(marquardt.outcome).toBe("solved");
    expect(marquardt.x[0]).toBeCloseTo(identity.x[0], 8);
    expect(marquardt.x[1]).toBeCloseTo(identity.x[1], 8);
  });

  it("is deterministic: identical input produces bit-identical output", () => {
    const run = (): LMResult => runLM(new Float64Array([3.1, 3.7]), circles, null);
    const a = run();
    const b = run();
    expect(a.iters).toBe(b.iters);
    expect(a.x.length).toBe(b.x.length);
    for (let i = 0; i < a.x.length; i++) {
      expect(Object.is(a.x[i], b.x[i])).toBe(true);
    }
    expect(Object.is(a.residualNorm, b.residualNorm)).toBe(true);
  });

  it("normalize re-projects accepted steps onto the manifold", () => {
    // normalize pins y to 5 while a residual pulls it to 0 — the pin
    // must win, mirroring the assembly solver's quaternion
    // re-projection contract.
    const evaluate = (x: Float64Array) => new Float64Array([x[0] - 1, x[1]]);
    const normalize = (x: Float64Array) => {
      x[1] = 5;
    };
    const result = runLM(new Float64Array([0, 0]), evaluate, normalize);
    expect(result.x[0]).toBeCloseTo(1, 6);
    expect(result.x[1]).toBe(5);
    expect(result.outcome).toBe("didnt-converge");
  });

  it("residualStop returns immediately on an already-solved warm start", () => {
    const result = runLM(new Float64Array([3, 4]), circles, null, { residualStop: true });
    expect(result.outcome).toBe("solved");
    expect(result.converged).toBe(true);
    expect(result.iters).toBe(0);
  });

  it("residualStop cuts the post-satisfaction polishing iterations", () => {
    const x0 = new Float64Array([3, 3.5]);
    const stopped = runLM(x0, circles, null, { residualStop: true });
    const legacy = runLM(x0, circles, null);
    expect(stopped.outcome).toBe("solved");
    expect(stopped.residualInfNorm).toBeLessThan(1e-8);
    expect(stopped.iters).toBeLessThanOrEqual(legacy.iters);
  });

  it("respects maxIters", () => {
    const result = runLM(new Float64Array([100, -100]), circles, null, { maxIters: 2 });
    expect(result.iters).toBeLessThanOrEqual(2);
  });

  it("does not mutate the input guess", () => {
    const x0 = new Float64Array([3, 3.5]);
    runLM(x0, circles, null);
    expect(Array.from(x0)).toEqual([3, 3.5]);
  });
});

describe("fdJacobian", () => {
  it("matches analytic partials on a nonlinear residual", () => {
    const evaluate = (x: Float64Array) =>
      new Float64Array([x[0] * x[0] * x[1] - 3, Math.sin(x[0]) + x[1] ** 3]);
    const x = new Float64Array([1.2, 0.7]);
    const J = new Float64Array(4);
    fdJacobian(evaluate, x, 2, J);
    const expected = [
      2 * 1.2 * 0.7,
      1.2 * 1.2,
      Math.cos(1.2),
      3 * 0.7 * 0.7,
    ];
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(J[i] - expected[i])).toBeLessThan(1e-7);
    }
    // x restored after probing.
    expect(Array.from(x)).toEqual([1.2, 0.7]);
  });
});
