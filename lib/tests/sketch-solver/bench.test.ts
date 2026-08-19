import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  end,
  entityRef,
  solve,
  start,
  type SolverRef,
} from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// P1 exit-criterion benchmark: the P0 rounded-staircase chains built
// through the real engine (entities + constraint statements, junction
// tangencies, decomposition, RCM, envelope Cholesky, warm-λ drags).
// Budget from the plan: warm drag-step ≤ 2 ms at 100 entities.
//
// Run with `LOG_PERF=1 npm test -- --run lib/tests/sketch-solver/bench.test.ts`
// for the timing table (printed via process.stdout.write — vitest
// swallows console.log from passing tests); PERF_BIG=1 adds 300.
const LOG = process.env.LOG_PERF === "1";
const RUN_BIG = process.env.PERF_BIG === "1";
const SIZES = LOG ? [10, 30, 100] : [10, 30];
const BIG = 300;

const SEG = 10;
const R = 3;

function buildStaircase(
  entityCount: number,
  dimFraction: number,
): { sys: SketchSystem; tip: SolverRef; exact: number[] } {
  const sys = new SketchSystem();
  let px = 0;
  let py = 0;
  let prev: { id: number; isLine: boolean } | null = null;
  let first: number | null = null;
  for (let i = 0; i < entityCount; i++) {
    const phase = i % 4;
    const dimmed = i < Math.round(entityCount * dimFraction);
    let id: number;
    let isLine: boolean;
    if (phase === 0 || phase === 2) {
      const ex = phase === 0 ? px + SEG : px;
      const ey = phase === 0 ? py : py + SEG;
      id = sys.line(px, py, ex, ey);
      isLine = true;
      sys.constrain({ kind: phase === 0 ? "horizontal" : "vertical", a: entityRef(id) });
      if (dimmed) {
        sys.constrain({ kind: "distance", a: start(id), b: end(id), value: SEG });
      }
      px = ex;
      py = ey;
    } else {
      // CCW quarter arc (phase 1) or CW quarter arc (phase 3).
      const cx = phase === 1 ? px : px + R;
      const cy = phase === 1 ? py + R : py;
      id = sys.arc(cx, cy, px, py, px + R, py + R);
      isLine = false;
      if (dimmed) {
        sys.constrain({ kind: "radius", a: entityRef(id), value: R });
      }
      px += R;
      py += R;
    }
    if (prev) {
      sys.constrain({ kind: "coincident", a: end(prev.id), b: start(id) });
      if (prev.isLine !== isLine) {
        sys.constrain({ kind: "tangent", a: entityRef(prev.id), b: entityRef(id) });
      }
    } else {
      first = id;
    }
    prev = { id, isLine };
  }
  sys.constrain({ kind: "fix", p: start(first!) });
  return { sys, tip: end(prev!.id), exact: Array.from(sys.values) };
}

function perturb(sys: SketchSystem, amp: number, seed: number): void {
  const rand = makeLcg(seed);
  const values = sys.values;
  for (let i = 0; i < values.length; i++) {
    values[i] += (rand() * 2 - 1) * amp;
  }
}

function report(label: string, lines: string[]): void {
  if (LOG) {
    process.stdout.write(`\n=== ${label} ===\n`);
    for (const line of lines) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function coldSolve(size: number): void {
  let best = Infinity;
  let iters = 0;
  let n = 0;
  for (let run = 0; run < 3; run++) {
    const { sys } = buildStaircase(size, 1);
    n = sys.paramCount;
    perturb(sys, 0.5, 11);
    const t0 = performance.now();
    const result = solve(sys);
    best = Math.min(best, performance.now() - t0);
    iters = result.iters;
    expect(result.outcome).toBe("solved");
  }
  report(`cold @ ${size} entities (n=${n})`, [
    `solve ${best.toFixed(2)} ms  (${iters} iters, ${(best / Math.max(iters, 1)).toFixed(3)} ms/iter)`,
  ]);
}

function warmDrag(size: number, steps: number): void {
  const { sys, tip } = buildStaircase(size, 0.5);
  expect(solve(sys).outcome).toBe("solved");
  const base = sys.pointValue(tip);
  // First drag frame builds and caches the gesture's plans — timed
  // separately (it is a one-off per gesture).
  const tFirst0 = performance.now();
  expect(
    solve(sys, { drag: { points: [{ ref: tip, x: base.x + 0.2, y: base.y + 0.2 }] } }).outcome,
  ).toBe("solved");
  const firstMs = performance.now() - tFirst0;
  let total = 0;
  let maxMs = 0;
  let totalIters = 0;
  for (let i = 2; i <= steps + 1; i++) {
    const target = { x: base.x + i * 0.2, y: base.y + i * 0.2 };
    const t0 = performance.now();
    const result = solve(sys, { drag: { points: [{ ref: tip, ...target }] } });
    const ms = performance.now() - t0;
    total += ms;
    maxMs = Math.max(maxMs, ms);
    totalIters += result.iters;
    expect(result.outcome).toBe("solved");
  }
  report(`warm drag @ ${size} entities (n=${sys.paramCount})`, [
    `first frame (plan build) ${firstMs.toFixed(2)} ms`,
    `steady ${(total / steps).toFixed(3)} ms avg, ${maxMs.toFixed(3)} ms max, ${(
      totalIters / steps
    ).toFixed(1)} iters/step`,
  ]);
}

describe("sketch-solver benchmark (P1 exit criterion)", () => {
  it("cold solves land on the exact staircase at small size", () => {
    const { sys, exact } = buildStaircase(10, 1);
    perturb(sys, 0.4, 3);
    expect(solve(sys).outcome).toBe("solved");
    // The chain ends on an arc → 1 sweep DOF; every other param must
    // return to the exact walk.
    const values = sys.values;
    let matches = 0;
    for (let i = 0; i < exact.length; i++) {
      if (Math.abs(values[i] - exact[i]) < 1e-6) {
        matches++;
      }
    }
    expect(exact.length - matches).toBeLessThanOrEqual(2); // the free endpoint
  });

  for (const size of SIZES) {
    it(`cold solve @ ${size} entities`, () => {
      coldSolve(size);
    });
    it(`warm drag @ ${size} entities`, () => {
      warmDrag(size, 20);
    });
  }

  it.runIf(RUN_BIG)(`cold + warm @ ${BIG} entities`, () => {
    coldSolve(BIG);
    warmDrag(BIG, 20);
  });
});
