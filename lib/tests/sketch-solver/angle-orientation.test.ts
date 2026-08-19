import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// Angle orientation refs: a bare line ref (or its 'end' point) means the
// start→end direction; a 'start' point ref reverses it. Values are the
// counterclockwise turn from a's oriented direction to b's — positive,
// [0, 2π) — so every sector at two lines' intersection is expressible
// without signed values.

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Line a fixed along +x; line b free, from a's end, initially at `guessDeg`. */
function pair(guessDeg: number): { sys: SketchSystem; a: number; b: number } {
  const sys = new SketchSystem();
  const a = sys.line(0, 0, 100, 0);
  const g = rad(guessDeg);
  const b = sys.line(100, 0, 100 + 80 * Math.cos(g), 80 * Math.sin(g));
  sys.constrain({ kind: "fix", p: start(a) });
  sys.constrain({ kind: "fix", p: end(a) });
  sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
  sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 80 });
  return { sys, a, b };
}

function bDirectionDeg(sys: SketchSystem, b: number): number {
  const s = sys.pointValue(start(b));
  const e = sys.pointValue(end(b));
  let deg = (Math.atan2(e.y - s.y, e.x - s.x) * 180) / Math.PI;
  if (deg < 0) {
    deg += 360;
  }
  return deg;
}

describe("angle orientation refs", () => {
  it("bare refs measure start→end to start→end (the existing behavior)", () => {
    const { sys, a, b } = pair(50);
    sys.constrain({ kind: "angle", a: entityRef(a), b: entityRef(b), value: rad(60) });
    expect(solve(sys).outcome).toBe("solved");
    expect(bDirectionDeg(sys, b)).toBeCloseTo(60, 5);
  });

  it("'end' point refs are the bare-ref default spelled out", () => {
    const { sys, a, b } = pair(50);
    sys.constrain({ kind: "angle", a: end(a), b: end(b), value: rad(60) });
    expect(solve(sys).outcome).toBe("solved");
    expect(bDirectionDeg(sys, b)).toBeCloseTo(60, 5);
  });

  it("a 'start' ref on b reverses b — the supplementary sector, still positive", () => {
    const { sys, a, b } = pair(230);
    // CCW from a (+x) to b-reversed = 60° pins b-reversed at 60°, so b
    // itself points at 240° (the guess sits near that branch).
    sys.constrain({ kind: "angle", a: entityRef(a), b: start(b), value: rad(60) });
    expect(solve(sys).outcome).toBe("solved");
    expect(bDirectionDeg(sys, b)).toBeCloseTo(240, 5);
  });

  it("a 'start' ref on a reverses a symmetrically", () => {
    const { sys, a, b } = pair(230);
    // CCW from a-reversed (pointing −x, 180°) to b = 60° ⇒ b at 240°.
    sys.constrain({ kind: "angle", a: start(a), b: entityRef(b), value: rad(60) });
    expect(solve(sys).outcome).toBe("solved");
    expect(bDirectionDeg(sys, b)).toBeCloseTo(240, 5);
  });

  it("values above 180° express the reflex turn without a sign", () => {
    const { sys, a, b } = pair(-80);
    // CCW from +x by 280° = −80° — the old signed spelling's replacement.
    sys.constrain({ kind: "angle", a: entityRef(a), b: entityRef(b), value: rad(280) });
    expect(solve(sys).outcome).toBe("solved");
    expect(bDirectionDeg(sys, b)).toBeCloseTo(280, 5);
  });

  it("a 'center' ref on a line refuses with a direction hint", () => {
    const { sys, a, b } = pair(50);
    expect(() =>
      sys.constrain({ kind: "angle", a: { entity: a, point: "center" }, b: entityRef(b), value: rad(60) }),
    ).toThrow(/no 'center' direction/);
  });
});
