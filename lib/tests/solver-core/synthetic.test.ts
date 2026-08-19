import { describe, expect, it } from "vitest";
import { fdJacobian, runLM, vecInfNorm } from "../../solver-core/index.js";
import { buildSyntheticSketch, perturbedGuess, withDrag } from "./synthetic.js";

describe("synthetic sketch systems", () => {
  it("the exact solution zeroes every residual", () => {
    for (const size of [4, 10, 30]) {
      const sys = buildSyntheticSketch(size);
      expect(vecInfNorm(sys.evaluate(sys.xExact))).toBeLessThan(1e-12);
    }
  });

  it("full dims make the system exactly determined", () => {
    const sys = buildSyntheticSketch(20, 1);
    expect(sys.m).toBe(sys.n);
    const under = buildSyntheticSketch(20, 0.5);
    expect(under.m).toBeLessThan(under.n);
  });

  it("analytic Jacobian matches centered FD at a perturbed point", () => {
    const sys = buildSyntheticSketch(10);
    const x = perturbedGuess(sys, 0.4, 7);
    const Jfd = new Float64Array(sys.m * sys.n);
    fdJacobian(sys.evaluate, x, sys.m, Jfd);
    const Jan = new Float64Array(sys.m * sys.n);
    sys.jacobian(x, Jan);
    let worst = 0;
    for (let i = 0; i < Jan.length; i++) {
      worst = Math.max(worst, Math.abs(Jan[i] - Jfd[i]));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("cold solve from perturbed guesses lands on the exact geometry", () => {
    const sys = buildSyntheticSketch(12);
    const result = runLM(perturbedGuess(sys, 0.5, 3), sys.evaluate, null, {
      jacobian: sys.jacobian,
      damping: "marquardt",
    });
    expect(result.outcome).toBe("solved");
    for (let i = 0; i < sys.n; i++) {
      expect(result.x[i]).toBeCloseTo(sys.xExact[i], 4);
    }
  });

  it("drag rows pull the tip while hard constraints hold", () => {
    const sys = buildSyntheticSketch(12, 0.5);
    const drag = withDrag(sys);
    drag.target.x = sys.xExact[sys.tipIx] + 2;
    drag.target.y = sys.xExact[sys.tipIy] + 1;
    const result = runLM(sys.xExact, drag.evaluate, null, {
      jacobian: drag.jacobian,
      damping: "marquardt",
    });
    // The tip reaches the target through the chain's free DOF…
    expect(result.x[sys.tipIx]).toBeCloseTo(drag.target.x, 4);
    expect(result.x[sys.tipIy]).toBeCloseTo(drag.target.y, 4);
    // …and the sketch constraints stay satisfied.
    expect(vecInfNorm(sys.evaluate(result.x))).toBeLessThan(1e-6);
  });
});
