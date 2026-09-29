// The offsetFrom statement (the sketcher's Offset tool output): offset lines
// and arcs held to their sources by one constraint. From deliberately-off
// guesses the solve must land the chain exactly — sharp corners through
// coincidents, tangent junctions and open ends on their own — with zero DOF
// left and no redundancy, and the statement must refuse what it cannot hold.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, arc, circle } from "../../../core/2d/index.js";
import { xAxis } from "../../../core/2d/index.js";
import {
  coincident, tangent, radius, horizontal, vertical, fix, distance, equal, offsetFrom,
} from "../../../core/constraints/index.js";

type P = { x: number; y: number };
type SolvedLinePayload = { start: P; end: P };
type SolvedArcPayload = { center: P; radius: number; start: P; end: P };

function sketchPayload() {
  const scene = render();
  const errors = scene.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
  const rendered = scene.getRenderedObjects();
  const payload = rendered.find(r => r.type === 'sketch')!.object;
  return { scene, errors, rendered, solver: payload.solver };
}

describe("offsetFrom statement", () => {
  setupOC();

  it("holds a sharp-cornered closed chain: DOF 0, no diagnostics, corners at the rail crossings", () => {
    sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [0, 30]);
      const d = line([0, 30], [0, 0]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      coincident(c.end(), d.start());
      coincident(d.end(), a.start());
      fix(a.start(), [0, 0]);
      horizontal(a);
      vertical(b);
      horizontal(c);
      vertical(d);
      distance(a.start(), a.end(), 40);
      distance(b.start(), b.end(), 30);
      // Off guesses on purpose: the tie must pull them to the 3 mm rails.
      const oa = line([-2.5, -3.4], [42.8, -2.7]);
      const ob = line([43.2, -3.1], [42.9, 33.3]);
      const oc = line([43.1, 32.8], [-2.9, 33.2]);
      const od = line([-3.3, 33.1], [-2.8, -3.2]);
      offsetFrom([oa, ob, oc, od], [a, b, c, d], 3);
      coincident(oa.end(), ob.start());
      coincident(ob.end(), oc.start());
      coincident(oc.end(), od.start());
      coincident(od.end(), oa.start());
    });
    const { errors, rendered, solver } = sketchPayload();
    expect(errors).toEqual([]);
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    const lines = rendered.filter(r => r.uniqueType === 'solved-line').map(r => r.object as SolvedLinePayload);
    const oa = lines.find(l => Math.abs(l.start.y + 3) < 1e-6 && Math.abs(l.end.y + 3) < 1e-6)!;
    expect(oa.start.x).toBeCloseTo(-3, 6);
    expect(oa.end.x).toBeCloseTo(43, 6);
  });

  it("holds a rounded rectangle offset without junction coincidents: DOF 0, no redundancy", () => {
    sketch('xy', () => {
      const b = line([5, 0], [35, 0]);
      const c1 = arc([35, 0], [40, 5], [35, 5]);
      const rt = line([40, 5], [40, 25]);
      const c2 = arc([40, 25], [35, 30], [35, 25]);
      const t = line([35, 30], [5, 30]);
      const c3 = arc([5, 30], [0, 25], [5, 25]);
      const lf = line([0, 25], [0, 5]);
      const c4 = arc([0, 5], [5, 0], [5, 5]);
      const lines = [b, rt, t, lf];
      const arcs = [c1, c2, c3, c4];
      for (let i = 0; i < 4; i++) {
        coincident(lines[i].end(), arcs[i].start());
        coincident(arcs[i].end(), lines[(i + 1) % 4].start());
        tangent(lines[i], arcs[i]);
        tangent(arcs[i], lines[(i + 1) % 4]);
      }
      horizontal(b);
      vertical(rt);
      horizontal(t);
      vertical(lf);
      radius(c1, 5);
      equal(c1, c2, c3, c4);
      fix(c4.center(), [5, 5]);
      distance(lf, rt, 40);
      distance(b, t, 30);
      // The outward offset by 2, guesses nudged off.
      const ob = line([5.3, -1.8], [34.7, -2.2]);
      const oc1 = arc([35.2, -2.1], [42.1, 4.8], [35.3, 4.9]);
      const ort = line([41.9, 5.2], [42.2, 24.8]);
      const oc2 = arc([42.1, 25.2], [34.8, 32.1], [35.1, 24.9]);
      const ot = line([34.9, 31.8], [5.2, 32.1]);
      const oc3 = arc([4.8, 32.2], [-2.1, 25.1], [5.1, 24.8]);
      const olf = line([-1.8, 24.9], [-2.2, 5.1]);
      const oc4 = arc([-2.1, 4.9], [5.2, -2.1], [4.9, 5.1]);
      offsetFrom([ob, oc1, ort, oc2, ot, oc3, olf, oc4], [b, c1, rt, c2, t, c3, lf, c4], 2);
    });
    const { errors, rendered, solver } = sketchPayload();
    expect(errors).toEqual([]);
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    const arcs = rendered.filter(r => r.uniqueType === 'solved-arc').map(r => r.object as SolvedArcPayload);
    const outer = arcs.filter(a => Math.abs(a.radius - 7) < 1e-6);
    expect(outer).toHaveLength(4);
    const oc1 = outer.find(a => Math.abs(a.center.x - 35) < 1e-6 && Math.abs(a.center.y - 5) < 1e-6)!;
    expect(oc1.start.x).toBeCloseTo(35, 6);
    expect(oc1.start.y).toBeCloseTo(-2, 6);
    expect(oc1.end.x).toBeCloseTo(42, 6);
    expect(oc1.end.y).toBeCloseTo(5, 6);
  });

  it("dimensioning the offset drives the source (bidirectional) and a circle offsets to a circle", () => {
    sketch('xy', () => {
      const l = line([0, 0], [40, 0]);
      fix(l.start(), [0, 0]);
      horizontal(l);
      const lo = line([0.2, 3.1], [39.8, 2.9]);
      offsetFrom(lo, l, 3);
      distance(lo.start(), lo.end(), 55);
      const c = circle([60, 20], 10);
      fix(c.center(), [60, 20]);
      const co = circle([60.3, 19.8], 14);
      offsetFrom(co, c, 2);
      radius(co, 9);
    });
    const { errors, rendered, solver } = sketchPayload();
    expect(errors).toEqual([]);
    expect(solver.outcome).toBe('solved');
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    const lines = rendered.filter(r => r.uniqueType === 'solved-line').map(r => r.object as SolvedLinePayload);
    const source = lines.find(l => Math.abs(l.start.y) < 1e-6)!;
    expect(source.end.x).toBeCloseTo(55, 5);
    const circles = rendered.filter(r => r.uniqueType === 'solved-circle').map(r => r.object as { diameter: number });
    expect(circles.map(c => c.diameter / 2).sort((a, b) => a - b)).toEqual([expect.closeTo(7, 6), expect.closeTo(9, 6)]);
  });

  it("refuses mismatched pairs, points, datums and a non-positive distance at the statement", () => {
    sketch('xy', () => {
      const l = line([0, 0], [40, 0]);
      const lo = line([0, 3], [40, 3]);
      const lo2 = line([0, 6], [40, 6]);
      offsetFrom([lo, lo2], l, 3);
      offsetFrom(lo.start(), l, 3);
      offsetFrom(lo, xAxis(), 3);
      offsetFrom(lo, l, -3);
    });
    const { errors } = sketchPayload();
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/pairs each offset entity with one source/);
    expect(errors[1]).toMatch(/is a point/);
    expect(errors[2]).toMatch(/xAxis\(\)/);
    expect(errors[3]).toMatch(/must be positive/);
  });
});
