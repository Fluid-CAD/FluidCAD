import { describe, expect, it } from "vitest";
import { SketchSystem, end, entityRef, solve, start } from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// Determinism: same input → bit-identical output across runs. The
// authoritative solve is server-side; cross-engine float caveats are
// documented in the phase doc, not solved here.

function buildAndRun(withDrag: boolean): number[] {
  const sys = new SketchSystem();
  const a = sys.line(0, 0, 100, 0);
  const b = sys.line(100, 0, 100, 80);
  const c = sys.line(100, 80, 0, 80);
  const d = sys.line(0, 80, 0, 0);
  sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
  sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
  sys.constrain({ kind: "coincident", a: end(c), b: start(d) });
  sys.constrain({ kind: "coincident", a: end(d), b: start(a) });
  sys.constrain({ kind: "horizontal", a: entityRef(a) });
  sys.constrain({ kind: "vertical", a: entityRef(b) });
  sys.constrain({ kind: "fix", p: start(a) });
  sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 100 });
  const rand = makeLcg(97);
  const values = sys.values;
  for (let i = 0; i < values.length; i++) {
    values[i] += (rand() * 2 - 1) * 0.4;
  }
  solve(sys);
  if (withDrag) {
    for (let i = 1; i <= 5; i++) {
      solve(sys, { drag: { points: [{ ref: end(c), x: 100 - i * 3, y: 80 + i * 2 }] } });
    }
  }
  return Array.from(sys.values);
}

describe("determinism", () => {
  it("cold solve is bit-identical across fresh systems", () => {
    expect(buildAndRun(false)).toEqual(buildAndRun(false));
  });

  it("a warm drag sequence is bit-identical across fresh systems", () => {
    expect(buildAndRun(true)).toEqual(buildAndRun(true));
  });

  it("re-solving a solved system is a bit-identical no-op", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0.2);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "fix", p: start(a) });
    expect(solve(sys).outcome).toBe("solved");
    const once = Array.from(sys.values);
    const again = solve(sys);
    expect(again.iters).toBe(0); // fixed-point skip
    expect(Array.from(sys.values)).toEqual(once);
  });
});
