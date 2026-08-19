import { describe, expect, it } from "vitest";
import { runLM, vecInfNorm, type LMOptions } from "../../solver-core/index.js";
import { buildSyntheticSketch, perturbedGuess, withDrag } from "./synthetic.js";

// P0 feasibility benchmark: cold solve + warm drag-step at growing
// sketch sizes, analytic vs centered-FD Jacobians, all through the
// dense LM core. The perf budget from the plan: warm drag-step ≤ 2 ms
// at 100 entities with the analytic Jacobian.
//
// Run with `LOG_PERF=1 npm test -- --run lib/tests/solver-core/bench.test.ts`
// to print the timing table; add PERF_BIG=1 for the 300-entity size
// (slow by design — it documents where dense Cholesky falls over).
const LOG = process.env.LOG_PERF === "1";
const RUN_BIG = process.env.PERF_BIG === "1";
// 100 entities rides the LOG_PERF tier: its cases alone cost ~24 s,
// a third of the whole default suite.
const SIZES = LOG ? [10, 30, 100] : [10, 30];
const BIG = 300;

const analyticOpts = (sys: { jacobian: LMOptions["jacobian"] }): LMOptions => ({
  jacobian: sys.jacobian,
  damping: "marquardt",
  residualStop: true,
});

function report(label: string, sys: { n: number; m: number }, lines: string[]): void {
  if (LOG) {
    // process.stdout.write, not console.log: vitest swallows console
    // output from passing tests.
    process.stdout.write(`\n=== ${label} (n=${sys.n} params, m=${sys.m} rows) ===\n`);
    for (const line of lines) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function coldSolve(size: number, mode: "analytic" | "fd"): void {
  const sys = buildSyntheticSketch(size, 1);
  const opts: LMOptions =
    mode === "analytic" ? analyticOpts(sys) : { damping: "marquardt", residualStop: true };
  const runs = mode === "analytic" ? 3 : 1;
  let best = Infinity;
  let iters = 0;
  for (let i = 0; i < runs; i++) {
    const x0 = perturbedGuess(sys, 0.5, 11);
    const t0 = performance.now();
    const result = runLM(x0, sys.evaluate, null, opts);
    best = Math.min(best, performance.now() - t0);
    iters = result.iters;
    expect(result.outcome).toBe("solved");
  }
  report(`cold ${mode} @ ${size} entities`, sys, [
    `solve ${best.toFixed(2)} ms  (${iters} iters, ${(best / Math.max(iters, 1)).toFixed(2)} ms/iter)`,
  ]);
}

function warmDrag(size: number, mode: "analytic" | "fd", steps: number): void {
  const sys = buildSyntheticSketch(size, 0.5);
  const drag = withDrag(sys);
  const opts: LMOptions =
    mode === "analytic"
      ? { jacobian: drag.jacobian, damping: "marquardt", residualStop: true }
      : { damping: "marquardt", residualStop: true };
  let x = sys.xExact;
  const tip0x = sys.xExact[sys.tipIx];
  const tip0y = sys.xExact[sys.tipIy];
  const times: number[] = [];
  let totalIters = 0;
  for (let s = 1; s <= steps; s++) {
    drag.target.x = tip0x + 0.2 * s;
    drag.target.y = tip0y + 0.2 * s;
    const t0 = performance.now();
    const result = runLM(x, drag.evaluate, null, opts);
    times.push(performance.now() - t0);
    totalIters += result.iters;
    x = result.x;
  }
  // Hard constraints hold through the whole drag.
  expect(vecInfNorm(sys.evaluate(x))).toBeLessThan(1e-6);
  // The tip actually followed the target through the free DOF.
  expect(x[sys.tipIx]).toBeCloseTo(drag.target.x, 3);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  report(`warm drag ${mode} @ ${size} entities`, sys, [
    `per step avg ${avg.toFixed(2)} ms, max ${max.toFixed(2)} ms  (${(totalIters / steps).toFixed(1)} iters/step, ${steps} steps)`,
  ]);
}

describe("solver-core benchmark", () => {
  for (const size of SIZES) {
    it(`cold solve, analytic Jacobian @ ${size} entities`, { timeout: 60_000 }, () => {
      coldSolve(size, "analytic");
    });
    it(`cold solve, FD Jacobian @ ${size} entities`, { timeout: 60_000 }, () => {
      coldSolve(size, "fd");
    });
    it(`warm drag, analytic Jacobian @ ${size} entities`, { timeout: 60_000 }, () => {
      warmDrag(size, "analytic", 20);
    });
    it(`warm drag, FD Jacobian @ ${size} entities`, { timeout: 60_000 }, () => {
      // FD at 100 entities costs seconds per step (the point this
      // benchmark makes); keep the sample small there.
      warmDrag(size, "fd", size >= 100 ? 5 : 20);
    });
  }

  it.runIf(RUN_BIG)(`cold solve, analytic Jacobian @ ${BIG} entities`, { timeout: 300_000 }, () => {
    coldSolve(BIG, "analytic");
  });
  it.runIf(RUN_BIG)(`warm drag, analytic Jacobian @ ${BIG} entities`, { timeout: 300_000 }, () => {
    warmDrag(BIG, "analytic", 5);
  });
});
