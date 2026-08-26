// Constraint-native fillet recipe (P8): the UI's Fillet tool emits, per
// corner, arc + 2 coincident + 2 tangent (+ radius dim), with the corner
// coincident removed. This pins that the emitted statement pattern SOLVES —
// from deliberately-off guesses the solver must trim both edges to the
// dimensioned radius's exact tangent points.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, arc } from "../../../core/2d/index.js";
import {
  coincident, tangent, radius, horizontal, vertical, fix,
} from "../../../core/constraints/index.js";

type P = { x: number; y: number };
type SolvedArcPayload = { center: P; radius: number; start: P; end: P };
type SolvedLinePayload = { start: P; end: P };

describe("constraint-native fillet recipe", () => {
  setupOC();

  it("solves the corner recipe to the dimensioned radius's exact tangent points", () => {
    // A 90° corner at (40, 0). The guesses describe a radius-5 fillet; the
    // radius dimension says 6 — the solve must move everything.
    sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const f = arc([35, 0], [40, 5], [35, 5]);
      coincident(f.start(), a.end());
      coincident(f.end(), b.start());
      tangent(a, f);
      tangent(f, b);
      radius(f, 6);
      horizontal(a);
      vertical(b);
      fix(a.start(), [0, 0]);
      fix(b.end(), [40, 30]);
    });
    const scene = render();

    const rendered = scene.getRenderedObjects();
    const arcPayload = rendered.find(r => r.uniqueType === 'solved-arc')!.object as SolvedArcPayload;
    expect(arcPayload.radius).toBeCloseTo(6, 6);
    expect(arcPayload.center.x).toBeCloseTo(34, 6);
    expect(arcPayload.center.y).toBeCloseTo(6, 6);
    expect(arcPayload.start.x).toBeCloseTo(34, 6);
    expect(arcPayload.start.y).toBeCloseTo(0, 6);
    expect(arcPayload.end.x).toBeCloseTo(40, 6);
    expect(arcPayload.end.y).toBeCloseTo(6, 6);

    // Both edges trimmed back to the tangent points.
    const lines = rendered
      .filter(r => r.uniqueType === 'solved-line')
      .map(r => r.object as SolvedLinePayload);
    const aLine = lines.find(l => Math.hypot(l.start.x, l.start.y) < 1e-6)!;
    const bLine = lines.find(l => Math.abs(l.end.y - 30) < 1e-6)!;
    expect(aLine.end.x).toBeCloseTo(34, 6);
    expect(aLine.end.y).toBeCloseTo(0, 6);
    expect(bLine.start.x).toBeCloseTo(40, 6);
    expect(bLine.start.y).toBeCloseTo(6, 6);
  });
});
