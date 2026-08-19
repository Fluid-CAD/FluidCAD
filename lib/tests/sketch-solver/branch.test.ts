import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  center,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// Branch-stability suite — the 2D preserveChirality. Guess proximity
// picks the solution branch at compile time; warm-started drags must
// never flip. Named regressions (cross-cutting rule 4): each case
// here pins a branch decision that must survive solver rewrites.

describe("branch stability", () => {
  it("tangent side: circle guessed above the line stays above, below stays below", () => {
    for (const side of [1, -1]) {
      const sys = new SketchSystem();
      const l = sys.line(0, 0, 20, 0);
      const c = sys.circle(8, side * 2.4, 3); // guessed off the tangent distance
      sys.constrain({ kind: "fix", p: start(l) });
      sys.constrain({ kind: "fix", p: end(l) });
      sys.constrain({ kind: "radius", a: entityRef(c), value: 3 });
      sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(c) });
      expect(solve(sys).outcome).toBe("solved");
      const cy = sys.pointValue(center(c)).y;
      expect(cy * side).toBeCloseTo(3, 6); // on its own side, at r
    }
  });

  it("circle–circle: external vs internal tangency from guess proximity", () => {
    const build = (r2: number, cx2: number): SketchSystem => {
      const sys = new SketchSystem();
      const a = sys.circle(0, 0, 5);
      const b = sys.circle(cx2, 0, r2);
      sys.constrain({ kind: "fix", p: center(a) });
      sys.constrain({ kind: "radius", a: entityRef(a), value: 5 });
      sys.constrain({ kind: "radius", a: entityRef(b), value: r2 });
      sys.constrain({ kind: "horizontal", a: center(a), b: center(b) });
      sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
      return sys;
    };
    // Guessed clearly outside: external tangency, center distance 7.
    const external = build(2, 7.8);
    expect(solve(external).outcome).toBe("solved");
    expect(Math.abs(external.pointValue(center(1)).x)).toBeCloseTo(7, 6);
    // Guessed inside: internal tangency, center distance 3.
    const internal = build(2, 2.6);
    expect(solve(internal).outcome).toBe("solved");
    expect(Math.abs(internal.pointValue(center(1)).x)).toBeCloseTo(3, 6);
  });

  it("point–line distance keeps the guessed side", () => {
    for (const side of [1, -1]) {
      const sys = new SketchSystem();
      const l = sys.line(0, 0, 10, 0);
      const p = sys.point(4, side * 1.3);
      sys.constrain({ kind: "fix", p: start(l) });
      sys.constrain({ kind: "fix", p: end(l) });
      sys.constrain({ kind: "distance", a: entityRef(p), b: entityRef(l), value: 5 });
      expect(solve(sys).outcome).toBe("solved");
      expect(sys.pointValue(entityRef(p)).y * side).toBeCloseTo(5, 6);
    }
  });

  it("arc bulge side survives a warm drag of the far endpoint", () => {
    // Quarter arc bulging CCW (center above the H line's end). Drag
    // the arc end around; the bulge (sign of cross from start
    // direction to center) must never flip.
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.arc(10, 3, 10, 0, 13, 3);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 10 });
    sys.constrain({ kind: "radius", a: entityRef(b), value: 3 });
    expect(solve(sys).outcome).toBe("solved");
    for (let i = 0; i <= 20; i++) {
      // Sweep the drag target through positions including ones below
      // the line — the bulge must persist by warm-start proximity.
      const angle = (i / 20) * Math.PI;
      const target = { x: 13 + 2 * Math.cos(angle), y: 3 - 6 * Math.sin(angle) };
      const result = solve(sys, { drag: { points: [{ ref: end(b), ...target }] } });
      expect(result.outcome).toBe("solved");
      const c = sys.pointValue(center(b));
      // Tangency + coincidence keep the center perpendicular to the
      // H line at the junction; CCW bulge means center above.
      expect(c.y).toBeGreaterThan(0);
      expect(Number.isFinite(c.x)).toBe(true);
    }
  });

  it("tangent side survives a drag pushing the circle toward the line", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 20, 0);
    const c = sys.circle(8, 3, 3);
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "radius", a: entityRef(c), value: 3 });
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(c) });
    expect(solve(sys).outcome).toBe("solved");
    // Drag the center down through and past the line in small steps.
    for (let i = 0; i <= 15; i++) {
      const result = solve(sys, {
        drag: { points: [{ ref: center(c), x: 8, y: 3 - i * 0.8 }] },
      });
      expect(result.outcome).toBe("solved");
      // The locked side keeps the center at +r above the line no
      // matter how far below the target goes.
      expect(sys.pointValue(center(c)).y).toBeCloseTo(3, 6);
    }
  });
});
