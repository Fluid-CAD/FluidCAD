import { describe, expect, it } from "vitest";
import {
  SketchSystem, X_AXIS_ENTITY, center, diagnose, end, entityRef, solve, start,
} from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// The user offset tie (offset-from): every row's analytic partials against
// centered finite differences, then the chain shapes the Offset tool emits
// — sharp corners (rail ends + coincidents), open ends and tangent junctions
// (foot ends) — must solve from off guesses with zero net DOF and no
// redundancy, and the tie must drive its source when a target is dimensioned.

type V2 = [number, number];
const D = 3;
const jit = (p: V2, k: number): V2 => [p[0] + 0.3 * Math.sin(k * 1.7), p[1] + 0.3 * Math.cos(k * 2.3)];

function fdCheckRows(sys: SketchSystem, seeds: number[], amp: number): void {
  const compiled = sys.compiled();
  expect(compiled.rows.length).toBeGreaterThan(0);
  for (const seed of seeds) {
    const rand = makeLcg(seed);
    const p = new Float64Array(sys.values);
    for (let i = 0; i < p.length; i++) {
      p[i] += (rand() * 2 - 1) * amp;
    }
    for (let k = 0; k < compiled.rows.length; k++) {
      const row = compiled.rows[k];
      const analytic = new Float64Array(row.params.length);
      row.jac(p, analytic);
      const byParam = new Map<number, number>();
      for (let s = 0; s < row.params.length; s++) {
        byParam.set(row.params[s], (byParam.get(row.params[s]) ?? 0) + analytic[s]);
      }
      for (const [gp, an] of byParam) {
        const h = 1e-6 * Math.max(1, Math.abs(p[gp]));
        const saved = p[gp];
        p[gp] = saved + h;
        const plus = row.eval(p);
        p[gp] = saved - h;
        const minus = row.eval(p);
        p[gp] = saved;
        const fd = (plus - minus) / (2 * h);
        expect(
          Math.abs(fd - an),
          `row ${k} (${sys.constraints()[compiled.rowConstraint[k]].spec.kind}) ∂/∂p[${gp}]: fd=${fd} analytic=${an}`,
        ).toBeLessThanOrEqual(2e-5 + 1e-4 * Math.abs(an));
      }
    }
  }
}

function pt(sys: SketchSystem, id: number, role: 'start' | 'end' | 'center'): V2 {
  const o = sys.entity(id).paramOffset;
  const kind = sys.entity(id).kind;
  const p = sys.values;
  if (kind === 'line') {
    return role === 'start' ? [p[o], p[o + 1]] : [p[o + 2], p[o + 3]];
  }
  if (role === 'center') {
    return [p[o], p[o + 1]];
  }
  return role === 'start' ? [p[o + 3], p[o + 4]] : [p[o + 5], p[o + 6]];
}

function radiusOf(sys: SketchSystem, id: number): number {
  return sys.values[sys.entity(id).paramOffset + 2];
}

function expectClean(sys: SketchSystem, dof: number): void {
  const result = solve(sys);
  expect(result.outcome).toBe('solved');
  const diag = diagnose(sys);
  expect(diag.conflicting).toEqual([]);
  expect(diag.redundant).toEqual([]);
  expect(diag.dof).toBe(dof);
}

/** A fully constrained 40 × 30 square, corners (0,0) (40,0) (40,30) (0,30), CCW. */
function square(sys: SketchSystem): number[] {
  const P: V2[] = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const src: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i];
    const b = P[(i + 1) % 4];
    src.push(sys.line(a[0], a[1], b[0], b[1]));
  }
  for (let i = 0; i < 4; i++) {
    sys.constrain({ kind: 'coincident', a: end(src[i]), b: start(src[(i + 1) % 4]) });
  }
  sys.constrain({ kind: 'fix', p: start(src[0]) });
  sys.constrain({ kind: 'horizontal', a: entityRef(src[0]) });
  sys.constrain({ kind: 'vertical', a: entityRef(src[1]) });
  sys.constrain({ kind: 'horizontal', a: entityRef(src[2]) });
  sys.constrain({ kind: 'vertical', a: entityRef(src[3]) });
  sys.constrain({ kind: 'distance', a: start(src[0]), b: end(src[0]), value: 40 });
  sys.constrain({ kind: 'distance', a: start(src[1]), b: end(src[1]), value: 30 });
  return src;
}

/**
 * A rounded rectangle, corners at (0,0) (w,0) (w,h) (0,h) with radius r,
 * walked CCW as bottom, corner arc, right, arc, top, arc, left, arc. `grow`
 * pushes every edge outward by that much (the offset guess); `jitter`
 * perturbs the literals.
 */
function roundedRect(sys: SketchSystem, w: number, h: number, r: number, grow: number, jitter: boolean) {
  const s = -grow;
  const J = (p: V2, k: number): V2 => jitter ? jit(p, k) : p;
  const b = sys.line(...J([r, s], 1), ...J([w - r, s], 2));
  const c1 = sys.arc(...J([w - r, r], 3), ...J([w - r, s], 4), ...J([w + grow, r], 5));
  const rt = sys.line(...J([w + grow, r], 6), ...J([w + grow, h - r], 7));
  const c2 = sys.arc(...J([w - r, h - r], 8), ...J([w + grow, h - r], 9), ...J([w - r, h + grow], 10));
  const t = sys.line(...J([w - r, h + grow], 11), ...J([r, h + grow], 12));
  const c3 = sys.arc(...J([r, h - r], 13), ...J([r, h + grow], 14), ...J([s, h - r], 15));
  const lf = sys.line(...J([s, h - r], 16), ...J([s, r], 17));
  const c4 = sys.arc(...J([r, r], 18), ...J([s, r], 19), ...J([r, s], 20));
  return { lines: [b, rt, t, lf], arcs: [c1, c2, c3, c4] };
}

function constrainRoundedRect(sys: SketchSystem, g: { lines: number[]; arcs: number[] }): void {
  for (let i = 0; i < 4; i++) {
    sys.constrain({ kind: 'coincident', a: end(g.lines[i]), b: start(g.arcs[i]) });
    sys.constrain({ kind: 'coincident', a: end(g.arcs[i]), b: start(g.lines[(i + 1) % 4]) });
    sys.constrain({ kind: 'tangent', a: entityRef(g.lines[i]), b: entityRef(g.arcs[i]) });
    sys.constrain({ kind: 'tangent', a: entityRef(g.arcs[i]), b: entityRef(g.lines[(i + 1) % 4]) });
  }
  sys.constrain({ kind: 'horizontal', a: entityRef(g.lines[0]) });
  sys.constrain({ kind: 'vertical', a: entityRef(g.lines[1]) });
  sys.constrain({ kind: 'horizontal', a: entityRef(g.lines[2]) });
  sys.constrain({ kind: 'vertical', a: entityRef(g.lines[3]) });
  sys.constrain({ kind: 'radius', a: entityRef(g.arcs[0]), value: 5 });
  for (let i = 1; i < 4; i++) {
    sys.constrain({ kind: 'equal', a: entityRef(g.arcs[0]), b: entityRef(g.arcs[i]) });
  }
  sys.constrain({ kind: 'fix', p: center(g.arcs[3]) });
  sys.constrain({ kind: 'distance', a: entityRef(g.lines[3]), b: entityRef(g.lines[1]), value: 40 });
  sys.constrain({ kind: 'distance', a: entityRef(g.lines[0]), b: entityRef(g.lines[2]), value: 30 });
}

describe("offset-from rows vs finite differences", () => {
  it("line pair (rail + foot rows), arc pair (center, radius, ray rows), circle pair", () => {
    const sys = new SketchSystem();
    const l = sys.line(1.2, 0.4, 30.5, 7.1);
    const lo = sys.line(0.3, 3.9, 29.1, 10.2);
    const a = sys.arc(10, 10, 20.3, 10.4, 9.7, 20.1);
    const ao = sys.arc(10.2, 9.8, 23.1, 10.1, 10.4, 23.2);
    const c = sys.circle(-5, 2, 4);
    const co = sys.circle(-4.8, 2.3, 7.1);
    // A stray line: one lo endpoint joined to it must NOT count as a chain
    // corner (only sibling targets do).
    sys.constrain({ kind: 'offset-from', targets: [entityRef(lo), entityRef(ao), entityRef(co)], sources: [entityRef(l), entityRef(a), entityRef(c)], value: 3 });
    const rows = sys.compiled().rows.length;
    // line: 2 rail + 2 along; arc: 3 + 2 ray; circle: 3; plus 4 arc-consistency.
    expect(rows).toBe(4 + 5 + 3 + 4);
    fdCheckRows(sys, [1, 2, 3], 0.4);
  });

  it("rail-only line rows at a chain corner", () => {
    const sys = new SketchSystem();
    const l1 = sys.line(0, 0, 40, 0);
    const l2 = sys.line(40, 0, 40, 30);
    const o1 = sys.line(0.2, -3.1, 43.3, -2.8);
    const o2 = sys.line(42.9, -3.2, 43.1, 30.4);
    sys.constrain({ kind: 'offset-from', targets: [entityRef(o1), entityRef(o2)], sources: [entityRef(l1), entityRef(l2)], value: 3 });
    sys.constrain({ kind: 'coincident', a: end(o1), b: start(o2) });
    // o1: rail start + along start + rail end; o2: rail start + rail end + along end; coincident 2.
    expect(sys.compiled().rows.length).toBe(3 + 3 + 2);
    fdCheckRows(sys, [4, 5], 0.4);
  });
});

describe("offset-from chains", () => {
  it("closed square, sharp corners: rails + coincidents, DOF 0, no redundancy", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const src = square(sys);
    const Q: V2[] = [[-D, -D], [40 + D, -D], [40 + D, 30 + D], [-D, 30 + D]];
    const off: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = jit(Q[i], i);
      const b = jit(Q[(i + 1) % 4], i + 9);
      off.push(sys.line(a[0], a[1], b[0], b[1]));
    }
    sys.constrain({ kind: 'offset-from', targets: off.map(entityRef), sources: src.map(entityRef), value: D });
    for (let i = 0; i < 4; i++) {
      sys.constrain({ kind: 'coincident', a: end(off[i]), b: start(off[(i + 1) % 4]) });
    }
    expectClean(sys, 0);
    expect(pt(sys, off[0], 'start')[0]).toBeCloseTo(-3, 8);
    expect(pt(sys, off[0], 'start')[1]).toBeCloseTo(-3, 8);
    expect(pt(sys, off[0], 'end')[0]).toBeCloseTo(43, 8);
    expect(pt(sys, off[2], 'start')[1]).toBeCloseTo(33, 8);
  });

  it("open polyline: free ends land on the perpendicular feet, DOF 0", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const P: V2[] = [[0, 0], [40, 0], [40, 30], [10, 30]];
    const src: number[] = [];
    for (let i = 0; i < 3; i++) {
      src.push(sys.line(P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]));
    }
    sys.constrain({ kind: 'coincident', a: end(src[0]), b: start(src[1]) });
    sys.constrain({ kind: 'coincident', a: end(src[1]), b: start(src[2]) });
    sys.constrain({ kind: 'fix', p: start(src[0]) });
    sys.constrain({ kind: 'horizontal', a: entityRef(src[0]) });
    sys.constrain({ kind: 'vertical', a: entityRef(src[1]) });
    sys.constrain({ kind: 'horizontal', a: entityRef(src[2]) });
    sys.constrain({ kind: 'distance', a: start(src[0]), b: end(src[0]), value: 40 });
    sys.constrain({ kind: 'distance', a: start(src[1]), b: end(src[1]), value: 30 });
    sys.constrain({ kind: 'distance', a: start(src[2]), b: end(src[2]), value: 30 });
    // Right-hand side (below, right, above): feet at the ends, intersections inside.
    const Q: V2[] = [[0, -D], [40 + D, -D], [40 + D, 30 + D], [10, 30 + D]];
    const off: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = jit(Q[i], i);
      const b = jit(Q[i + 1], i + 5);
      off.push(sys.line(a[0], a[1], b[0], b[1]));
    }
    sys.constrain({ kind: 'offset-from', targets: off.map(entityRef), sources: src.map(entityRef), value: D });
    sys.constrain({ kind: 'coincident', a: end(off[0]), b: start(off[1]) });
    sys.constrain({ kind: 'coincident', a: end(off[1]), b: start(off[2]) });
    expectClean(sys, 0);
    expect(pt(sys, off[0], 'start')[0]).toBeCloseTo(0, 8);
    expect(pt(sys, off[0], 'start')[1]).toBeCloseTo(-3, 8);
    expect(pt(sys, off[0], 'end')[0]).toBeCloseTo(43, 8);
    expect(pt(sys, off[2], 'end')[0]).toBeCloseTo(10, 8);
    expect(pt(sys, off[2], 'end')[1]).toBeCloseTo(33, 8);
  });

  it("rounded rectangle: tangent junctions need no coincident, DOF 0, no redundancy", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const src = roundedRect(sys, 40, 30, 5, 0, false);
    constrainRoundedRect(sys, src);
    const off = roundedRect(sys, 40, 30, 5, D, true);
    const targets: number[] = [];
    const sources: number[] = [];
    for (let i = 0; i < 4; i++) {
      targets.push(off.lines[i], off.arcs[i]);
      sources.push(src.lines[i], src.arcs[i]);
    }
    sys.constrain({ kind: 'offset-from', targets: targets.map(entityRef), sources: sources.map(entityRef), value: D });
    expectClean(sys, 0);
    // Junctions meet exactly, the arcs are concentric at R + d.
    for (let i = 0; i < 4; i++) {
      const a = pt(sys, off.lines[i], 'end');
      const b = pt(sys, off.arcs[i], 'start');
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
      expect(radiusOf(sys, off.arcs[i])).toBeCloseTo(8, 9);
      const tc = pt(sys, off.arcs[i], 'center');
      const sc = pt(sys, src.arcs[i], 'center');
      expect(tc[0]).toBeCloseTo(sc[0], 9);
      expect(tc[1]).toBeCloseTo(sc[1], 9);
    }
    expect(pt(sys, off.lines[0], 'start')[1]).toBeCloseTo(-3, 6);
    expect(pt(sys, off.lines[0], 'start')[0]).toBeCloseTo(5, 6);
  });

  it("inside offset of a rounded rectangle: arcs at R − d", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const src = roundedRect(sys, 40, 30, 5, 0, false);
    constrainRoundedRect(sys, src);
    const off = roundedRect(sys, 40, 30, 5, -2, true);
    const targets: number[] = [];
    const sources: number[] = [];
    for (let i = 0; i < 4; i++) {
      targets.push(off.lines[i], off.arcs[i]);
      sources.push(src.lines[i], src.arcs[i]);
    }
    sys.constrain({ kind: 'offset-from', targets: targets.map(entityRef), sources: sources.map(entityRef), value: 2 });
    expectClean(sys, 0);
    for (let i = 0; i < 4; i++) {
      expect(radiusOf(sys, off.arcs[i])).toBeCloseTo(3, 9);
    }
    expect(pt(sys, off.lines[0], 'start')[1]).toBeCloseTo(2, 9);
  });

  it("line + arc with a sharp corner between them: rail ends + coincident", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    // Horizontal line (0,0)→(30,0); arc centred (20,-10) from (30,0) CCW —
    // the tangent there is (−1, 1)/√2: a 135° kink.
    const l = sys.line(0, 0, 30, 0);
    const cx = 20;
    const cy = -10;
    const r = Math.hypot(10, 10);
    const a1 = Math.atan2(10, 10);
    const a2 = a1 + Math.PI / 2;
    const a = sys.arc(cx, cy, 30, 0, cx + r * Math.cos(a2), cy + r * Math.sin(a2));
    sys.constrain({ kind: 'coincident', a: end(l), b: start(a) });
    sys.constrain({ kind: 'fix', p: start(l) });
    sys.constrain({ kind: 'horizontal', a: entityRef(l) });
    sys.constrain({ kind: 'distance', a: start(l), b: end(l), value: 30 });
    sys.constrain({ kind: 'fix', p: center(a) });
    // The end lands on the x-axis at (10, 0): one row pins the sweep.
    sys.constrain({ kind: 'coincident', a: end(a), b: entityRef(X_AXIS_ENTITY) });
    expectClean(sys, 0);
    // Offset above the line (left side) / outside the arc: the rails meet
    // where y = 3 crosses the circle of radius r + 3.
    const R = r + D;
    const ix = cx + Math.sqrt(R * R - (D - cy) * (D - cy));
    const lo = sys.line(...jit([0, D], 1), ...jit([ix, D], 2));
    const ao = sys.arc(...jit([cx, cy], 3), ...jit([ix, D], 4), ...jit([cx + R * Math.cos(a2), cy + R * Math.sin(a2)], 5));
    sys.constrain({ kind: 'offset-from', targets: [entityRef(lo), entityRef(ao)], sources: [entityRef(l), entityRef(a)], value: D });
    sys.constrain({ kind: 'coincident', a: end(lo), b: start(ao) });
    expectClean(sys, 0);
    expect(pt(sys, lo, 'start')).toEqual([expect.closeTo(0, 8), expect.closeTo(3, 8)]);
    expect(pt(sys, lo, 'end')[0]).toBeCloseTo(ix, 8);
    expect(pt(sys, lo, 'end')[1]).toBeCloseTo(3, 8);
    expect(radiusOf(sys, ao)).toBeCloseTo(R, 9);
    const e = pt(sys, ao, 'end');
    expect(Math.atan2(e[1] - cy, e[0] - cx)).toBeCloseTo(a2, 9);
  });

  it("circle: concentric at R + d, no redundancy", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const c = sys.circle(10, 10, 8);
    sys.constrain({ kind: 'fix', p: center(c) });
    sys.constrain({ kind: 'radius', a: entityRef(c), value: 8 });
    const co = sys.circle(10.3, 9.7, 10.5);
    sys.constrain({ kind: 'offset-from', targets: [entityRef(co)], sources: [entityRef(c)], value: 2.5 });
    expectClean(sys, 0);
    expect(radiusOf(sys, co)).toBeCloseTo(10.5, 9);
    expect(pt(sys, co, 'center')).toEqual([expect.closeTo(10, 9), expect.closeTo(10, 9)]);
  });

  it("is bidirectional: dimensioning the offset line drives the source", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const l = sys.line(0, 0, 40, 0);
    sys.constrain({ kind: 'fix', p: start(l) });
    sys.constrain({ kind: 'horizontal', a: entityRef(l) });
    const lo = sys.line(0.1, 3.2, 39.8, 2.9);
    sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(l)], value: 3 });
    // The source's length is free; dimension the OFFSET line's length.
    sys.constrain({ kind: 'distance', a: start(lo), b: end(lo), value: 55 });
    expectClean(sys, 0);
    expect(pt(sys, l, 'end')[0]).toBeCloseTo(55, 6);
    expect(pt(sys, lo, 'end')).toEqual([expect.closeTo(55, 6), expect.closeTo(3, 6)]);
  });

  it("names the statement in a conflict instead of boosting it", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const l = sys.line(0, 0, 40, 0);
    sys.constrain({ kind: 'fix', p: start(l) });
    sys.constrain({ kind: 'fix', p: end(l) });
    const lo = sys.line(0, 3, 40, 3);
    const tie = sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(l)], value: 3 });
    const dim = sys.constrain({ kind: 'distance', a: start(lo), b: entityRef(l), value: 7 });
    solve(sys);
    const diag = diagnose(sys);
    expect(diag.conflicting).toContain(dim);
    expect(diag.conflicting).toContain(tie);
  });
});

describe("offset-from validation", () => {
  it("refuses a non-positive value, mismatched kinds, points and self-offsets", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 40, 0);
    const lo = sys.line(0, 3, 40, 3);
    const c = sys.circle(0, 0, 5);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(l)], value: 0 }))
      .toThrow(/positive distance/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(l)], value: -3 }))
      .toThrow(/positive distance/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(c)], sources: [entityRef(l)], value: 3 }))
      .toThrow(/a circle offsets a circle, got a line source/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [start(lo)], sources: [entityRef(l)], value: 3 }))
      .toThrow(/not points/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(lo)], value: 3 }))
      .toThrow(/both an offset entity and a source/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(lo), entityRef(lo)], sources: [entityRef(l), entityRef(l)], value: 3 }))
      .toThrow(/twice/);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(lo)], sources: [entityRef(l), entityRef(l)], value: 3 }))
      .toThrow(/pairs each offset entity with one source/);
  });

  it("refuses an inside offset the arc has no room for", () => {
    const sys = new SketchSystem();
    const a = sys.arc(0, 0, 4, 0, 0, 4);
    const ao = sys.arc(0, 0, 1, 0, 0, 1);
    expect(() => sys.constrain({ kind: 'offset-from', targets: [entityRef(ao)], sources: [entityRef(a)], value: 5 }))
      .toThrow(/no room/);
  });
});
