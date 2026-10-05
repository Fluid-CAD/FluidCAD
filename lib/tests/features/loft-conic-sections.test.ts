import { describe, expect, it } from "vitest";
import { setupOC } from "../setup.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { getOC } from "../../oc/init.js";
import { ConicArc, ConicArcs, ConicFrame } from "../../oc/loft/conic-arc.js";
import { CurveData } from "../../oc/loft/curve-data.js";
import { evaluateBSplinePoint } from "../../oc/loft/curve-eval.js";
import { SectionCurve } from "../../oc/loft/section-curve.js";

const circleFrame = (radius: number, z = 0): ConicFrame =>
  ({ center: [0, 0, z], major: [radius, 0, 0], minor: [0, radius, 0] });

function arcEdge(z: number, radius: number, from: number, to: number) {
  const at = (angle: number) => new Point(radius * Math.cos(angle), radius * Math.sin(angle), z);
  const curve = Geometry.makeArc(new Point(0, 0, z), radius, new Vector3d(0, 0, 1), at(from), at(to));
  try {
    return Geometry.makeEdgeFromCurve(curve);
  } finally {
    curve.delete();
  }
}

/** Largest multiplicity among a native curve's interior knots. */
function interiorMultiplicities(curve: { NbKnots(): number; Multiplicity(i: number): number }): number[] {
  return Array.from({ length: curve.NbKnots() - 2 }, (_, i) => curve.Multiplicity(i + 2));
}

describe("loft conic sections", () => {
  setupOC();

  describe("one exact span per arc", () => {
    const sweeps: [string, number, number][] = [
      ["a sliver", 0.2, 0.2 + 1e-4],
      ["30°", 0, Math.PI / 6],
      ["a quarter", 1, 1 + Math.PI / 2],
      ["a half", -2, -2 + Math.PI],
      ["three quarters", 0.5, 0.5 + 1.5 * Math.PI],
      ["a full turn", 0, 2 * Math.PI],
      ["a full turn from elsewhere", 2.5, 2.5 + 2 * Math.PI],
      ["a clockwise half", 3, 3 - Math.PI],
      ["a clockwise full turn", 1, 1 - 2 * Math.PI],
    ];

    it.each(sweeps)("traces %s of a circle exactly, following the angle", (_, from, to) => {
      const arc: ConicArc = { frame: circleFrame(40), from, to };
      const curve = ConicArcs.toBSpline(arc);

      expect(curve.degree).toBe(6);
      expect(curve.knots).toEqual([0, 1]);
      expect(curve.poles).toHaveLength(7);
      for (const weight of curve.weights!) {
        expect(weight).toBeGreaterThan(0);
      }

      for (let i = 0; i <= 64; i++) {
        const s = i / 64;
        const point = evaluateBSplinePoint(curve, s);
        expect(Math.abs(Math.hypot(point[0], point[1]) - 40)).toBeLessThan(1e-11);
        expect(Math.abs(point[2])).toBeLessThan(1e-12);

        // The parameter is the angle, to within a fifth of a degree.
        const expected = ConicArcs.pointAt(arc.frame, from + (to - from) * s);
        expect(Math.hypot(point[0] - expected[0], point[1] - expected[1])).toBeLessThan(40 * 3.5e-3);
      }
      const start = evaluateBSplinePoint(curve, 0);
      const end = evaluateBSplinePoint(curve, 1);
      expect(Math.hypot(start[0] - 40 * Math.cos(from), start[1] - 40 * Math.sin(from))).toBeLessThan(1e-11);
      expect(Math.hypot(end[0] - 40 * Math.cos(to), end[1] - 40 * Math.sin(to))).toBeLessThan(1e-11);
    });

    it("traces an ellipse exactly", () => {
      const frame: ConicFrame = { center: [5, -3, 12], major: [30, 0, 0], minor: [0, 0, 10] };
      const curve = ConicArcs.toBSpline({ frame, from: 0.4, to: 0.4 + 2 * Math.PI });
      for (let i = 0; i <= 64; i++) {
        const point = evaluateBSplinePoint(curve, i / 64);
        const x = (point[0] - 5) / 30;
        const z = (point[2] - 12) / 10;
        expect(Math.abs(x * x + z * z - 1)).toBeLessThan(1e-12);
        expect(point[1]).toBeCloseTo(-3, 12);
      }
    });

    it("finds the parameter of an angle", () => {
      for (const [from, to] of [[0, 2 * Math.PI], [1, 1 + Math.PI / 2], [3, 3 - 4]] as const) {
        const arc: ConicArc = { frame: circleFrame(25), from, to };
        const curve = ConicArcs.toBSpline(arc);
        for (const fraction of [0, 0.1, 0.37, 0.5, 0.81, 1]) {
          const angle = from + (to - from) * fraction;
          const point = evaluateBSplinePoint(curve, ConicArcs.parameterAt(arc, angle));
          const expected = ConicArcs.pointAt(arc.frame, angle);
          expect(Math.hypot(point[0] - expected[0], point[1] - expected[1])).toBeLessThan(1e-11);
        }
      }
    });

    it("turns a whole circle along itself without touching knots or weights", () => {
      const frame = circleFrame(40, 7);
      const curve = ConicArcs.toBSpline({ frame, from: 0, to: 2 * Math.PI });
      const target = ConicArcs.pointAt(frame, 2.1);
      const turned = { ...curve, poles: ConicArcs.turn(curve.poles, frame, curve.poles[0], target) };

      const start = evaluateBSplinePoint(turned, 0);
      expect(Math.hypot(start[0] - target[0], start[1] - target[1], start[2] - target[2])).toBeLessThan(1e-11);
      for (let i = 0; i <= 32; i++) {
        const point = evaluateBSplinePoint(turned, i / 32);
        expect(Math.abs(Math.hypot(point[0], point[1]) - 40)).toBeLessThan(1e-11);
        expect(point[2]).toBeCloseTo(7, 12);
      }
    });
  });

  describe("edges along one conic", () => {
    it("carries an arc on across a different frame, and refuses anything else", () => {
      const first: ConicArc = { frame: circleFrame(20), from: 0, to: 1 };
      // The same circle described from another start axis, traversed the same way.
      const turned: ConicFrame = { center: [0, 0, 0], major: [0, 20, 0], minor: [-20, 0, 0] };
      const next: ConicArc = { frame: turned, from: 1 - Math.PI / 2, to: 2 - Math.PI / 2 };
      expect(ConicArcs.extend(first, next)).toEqual({ frame: first.frame, from: 0, to: 2 });

      // Seen from below, the same travel runs clockwise.
      const flipped: ConicFrame = { center: [0, 0, 0], major: [20, 0, 0], minor: [0, -20, 0] };
      expect(ConicArcs.extend(first, { frame: flipped, from: -1, to: -2 })).toEqual({ frame: first.frame, from: 0, to: 2 });

      expect(ConicArcs.extend(first, { frame: circleFrame(21), from: 1, to: 2 })).toBeNull();
      expect(ConicArcs.extend(first, { frame: first.frame, from: 1, to: 0.5 })).toBeNull();
      expect(ConicArcs.extend(first, { frame: first.frame, from: 1.5, to: 2 })).toBeNull();
      expect(ConicArcs.extend(first, { frame: first.frame, from: 1, to: 1 + 2 * Math.PI })).toBeNull();
    });

    it("makes a circle one span, with no knot anywhere", () => {
      const oc = getOC();
      const axes = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1));
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axes, 15));
      const wire = new oc.BRepBuilderAPI_MakeWire(edgeMaker.Edge()).Wire();

      const section = SectionCurve.fromWireWithVertices(wire);
      try {
        expect(section.curve.Degree()).toBe(6);
        expect(section.curve.NbKnots()).toBe(2);
        expect(section.curve.NbPoles()).toBe(7);
        expect(section.vertices).toEqual([]);
        expect(section.conic?.center).toEqual([0, 0, 0]);
      } finally {
        section.curve.delete();
      }
    });

    it("makes arcs of one circle that same span, cut at their vertices", () => {
      const angles = [0.3, 1.4, 2 * Math.PI - 2, 2 * Math.PI + 0.3];
      const edges = [0, 1, 2].map(i => arcEdge(5, 30, angles[i], angles[i + 1]));
      const wire = WireOps.makeWireFromEdges(edges);

      const section = SectionCurve.fromWireWithVertices(wire.getShape());
      try {
        // One piece of the whole circle: the two interior vertices are knots
        // of full multiplicity, and nothing else is a knot.
        expect(section.conic).toBeDefined();
        expect(section.curve.NbKnots()).toBe(4);
        expect(interiorMultiplicities(section.curve)).toEqual([6, 6]);
        expect(section.vertices).toHaveLength(3);
        for (const [i, vertex] of section.vertices.entries()) {
          const point = section.curve.Value(vertex.parameter);
          expect(Math.hypot(point.X() - 30 * Math.cos(angles[i]), point.Y() - 30 * Math.sin(angles[i]))).toBeLessThan(1e-9);
          point.delete();
        }

        // Those knots hold no shape: the curve is the uncut circle.
        const whole = ConicArcs.toBSpline({ frame: circleFrame(30, 5), from: angles[0], to: angles[3] });
        const data = CurveData.read(section.curve);
        for (let i = 0; i <= 50; i++) {
          const a = evaluateBSplinePoint(data, i / 50);
          const b = evaluateBSplinePoint(whole, i / 50);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-10);
        }
      } finally {
        section.curve.delete();
      }
    });

    it("starts a closed wire where a run along one conic starts, not in its middle", () => {
      // A D: the round side drawn as two arcs, with the wire starting at the
      // vertex between them.
      const second = arcEdge(0, 20, 0, Math.PI / 2);
      const chord = EdgeOps.makeLineEdge(new Point(0, 20, 0), new Point(0, -20, 0));
      const first = arcEdge(0, 20, -Math.PI / 2, 0);
      const wire = WireOps.makeWireFromEdges([second, chord, first]);

      const section = SectionCurve.fromWireWithVertices(wire.getShape());
      try {
        // The curve starts at the chord — the first edge that does not carry
        // on from the one before it — so the round side is one span, cut at
        // the vertex between its two arcs.
        const start = section.curve.Value(0);
        expect(Math.hypot(start.X(), start.Y() - 20)).toBeLessThan(1e-9);
        start.delete();
        expect(section.curve.Degree()).toBe(6);
        expect(section.curve.NbKnots()).toBe(4);
        expect(section.conic).toBeUndefined();

        // Vertices keep the wire's order; only their parameters moved.
        const expected = [[20, 0], [0, 20], [0, -20]];
        expect(section.vertices).toHaveLength(3);
        for (const [i, vertex] of section.vertices.entries()) {
          const point = section.curve.Value(vertex.parameter);
          expect(Math.hypot(point.X() - expected[i][0], point.Y() - expected[i][1])).toBeLessThan(1e-9);
          point.delete();
        }
        expect(section.vertices[1].parameter).toBe(0);

        // The round side is exact, and smooth across the vertex inside it.
        const data = CurveData.read(section.curve);
        const middle = section.vertices[0].parameter;
        for (const u of [middle - 1e-3, middle, middle + 1e-3]) {
          const point = evaluateBSplinePoint(data, u);
          expect(Math.abs(Math.hypot(point[0], point[1]) - 20)).toBeLessThan(1e-11);
        }
      } finally {
        section.curve.delete();
      }
    });
  });

  describe("polynomial stand-in", () => {
    it("keeps junctions C0 and everything between them C1", () => {
      const wire = WireOps.makeWireFromEdges([
        arcEdge(0, 25, 0, 2), arcEdge(0, 25, 2, 2 * Math.PI),
      ]);

      const section = SectionCurve.fromWireWithVertices(wire.getShape(), true);
      try {
        expect(section.curve.IsRational()).toBe(false);
        expect(section.curve.Degree()).toBe(3);
        const full = interiorMultiplicities(section.curve).filter(multiplicity => multiplicity === 3);
        expect(full).toHaveLength(1);
        expect(interiorMultiplicities(section.curve).every(multiplicity => multiplicity >= 2)).toBe(true);

        const junction = section.vertices[1].parameter;
        const point = section.curve.Value(junction);
        expect(Math.hypot(point.X() - 25 * Math.cos(2), point.Y() - 25 * Math.sin(2))).toBeLessThan(1e-9);
        point.delete();

        const sample = new (getOC().gp_Pnt)();
        for (let i = 0; i <= 400; i++) {
          section.curve.D0(i / 400, sample);
          expect(Math.abs(Math.hypot(sample.X(), sample.Y()) - 25)).toBeLessThan(1e-4);
        }
        sample.delete();
      } finally {
        section.curve.delete();
      }
    });

    it("fits a circle metres across", () => {
      const oc = getOC();
      const axes = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1));
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axes, 3000));
      const wire = new oc.BRepBuilderAPI_MakeWire(edgeMaker.Edge()).Wire();

      const section = SectionCurve.fromWireWithVertices(wire, true);
      try {
        const sample = new oc.gp_Pnt();
        for (let i = 0; i <= 2000; i++) {
          section.curve.D0(i / 2000, sample);
          expect(Math.abs(Math.hypot(sample.X(), sample.Y()) - 3000)).toBeLessThan(1e-4);
        }
        sample.delete();
      } finally {
        section.curve.delete();
      }
    });
  });
});
