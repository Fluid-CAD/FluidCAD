import { describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, plane, origin, line, loft, part } from "../../core/index.js";
import { coincident, horizontal, vertical, midpoint, distance } from "../../core/constraints/index.js";
import { Loft } from "../../features/loft.js";
import { Skinning } from "../../oc/loft/skinning.js";
import { evaluateBSplinePoint } from "../../oc/loft/curve-eval.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { BSplineCurveData } from "../../math/bspline-interpolation.js";

/** Independent numerical endpoint derivative, in the column's parameterization. */
function derivative(curve: BSplineCurveData, atEnd: boolean): number[] {
  const t = atEnd ? curve.knots.at(-1)! : curve.knots[0];
  const h = (curve.knots.at(-1)! - curve.knots[0]) * 1e-7;
  const a = evaluateBSplinePoint(curve, atEnd ? t - h : t);
  const b = evaluateBSplinePoint(curve, atEnd ? t : t + h);
  return a.map((value, d) => (b[d] - value) / h);
}

describe("single-ended loft condition influence", () => {
  setupOC();

  it.each(["start", "end"] as const)("preserves the opposite automatic tangent with a single %s condition", end => {
    // A rotated correspondence through three sections, with unequal section spacing.
    const columns = [[[-30, 30, 0]], [[-20, -20, 50]], [[25, -25, 100]]];
    const params = [0, 0.5142602949021641, 1];
    const baseline = Skinning.interpolateColumns(columns, params);
    const freeEnd = end === "start";
    const automatic = derivative({ ...baseline.vBasis, poles: baseline.grid[0] }, freeEnd);
    for (const requested of [[0, 0, 138.8679721015887], [0, 0, 1.388679721015887], [40, -30, 0]]) {
      const skin = Skinning.interpolateColumns(columns, params,
        end === "start" ? [requested] : null, end === "end" ? [requested] : null);
      const curve = { ...skin.vBasis, poles: skin.grid[0] };
      const actualFree = derivative(curve, freeEnd);
      const actualConstrained = derivative(curve, !freeEnd);
      for (let d = 0; d < 3; d++) {
        expect(actualFree[d]).toBeCloseTo(automatic[d], 3);
        expect(actualConstrained[d]).toBeCloseTo(requested[d], 3);
      }
      for (const [i, t] of params.entries()) {
        const point = evaluateBSplinePoint(curve, t);
        for (let d = 0; d < 3; d++) {
          expect(point[d]).toBeCloseTo(columns[i][0][d], 9);
        }
      }
    }
  });

  it.each([2, 5])("retains the free tangent for %i sections on a non-normalized parameter interval", count => {
    const params = Array.from({ length: count }, (_, i) => 2 + (i / (count - 1)) ** 1.2 * 3);
    const columns = params.map(t => [[t * 3, Math.sin(t) * 4, t * 10]]);
    const baseline = Skinning.interpolateColumns(columns, params);
    const expected = derivative({ ...baseline.vBasis, poles: baseline.grid[0] }, true);
    const skin = Skinning.interpolateColumns(columns, params, [[0, 0, 10]]);
    const actual = derivative({ ...skin.vBasis, poles: skin.grid[0] }, true);
    for (let d = 0; d < 3; d++) {
      expect(actual[d]).toBeCloseTo(expected[d], 4);
    }
  });

  it("keeps a three-square twist below 60 mm in the upper span with a normal start", () => {
    let feature!: Loft;
    part("test", () => {
      const profiles = [60, 40, 50].map((width, k) => sketch(k === 0 ? "xy" : plane("xy", k * 50), () => {
        const r = width / 2;
        const l1 = line([-r, -r], [r, -r]);
        const l2 = line([r, -r], [r, r]);
        const l3 = line([r, r], [-r, r]);
        const l4 = line([-r, r], [-r, -r]);
        coincident(l1.end(), l2.start());
        coincident(l2.end(), l3.start());
        coincident(l3.end(), l4.start());
        coincident(l4.end(), l1.start());
        horizontal(l1);
        horizontal(l3);
        vertical(l2);
        vertical(l4);
        distance(l1.start(), l1.end(), width);
        if (k > 0) {
          distance(l2.start(), l2.end(), width);
        }
        midpoint(origin(), l1.start(), l3.start());
        return { l1, l3 };
      }));
      feature = loft(...profiles).connect(
        profiles[0].geometries.l3.end(), profiles[1].geometries.l1.start(), profiles[2].geometries.l1.end(),
      ).startCondition("normal", 1) as Loft;
    });
    render();
    expect(feature.getError()).toBeNull();
    const solid = feature.getShapes()[0];
    expect(ShapeValidator.validate(solid.getShape()).findings).toEqual([]);
    const edges = Explorer.findEdgesWrapped(solid);
    try {
      const connection = [new Point(-30, 30, 0), new Point(-20, -20, 50), new Point(25, -25, 100)];
      expect(edges.some(edge => connection.every(point => EdgeOps.distancePointToEdge(point, edge) < 1e-6))).toBe(true);
      // All four corner curves have the same envelope by square symmetry.
      // The old single cubic bulged to 81.05 mm between the 40 and 50 mm profiles.
      const mesh = solid.getMeshes()!.flatMap(mesh => mesh.vertices);
      const upper = Array.from({ length: mesh.length / 3 }, (_, i) => mesh.slice(i * 3, i * 3 + 3))
        .filter(point => point[2] >= 50);
      expect(2 * Math.max(...upper.map(point => Math.max(Math.abs(point[0]), Math.abs(point[1]))))).toBeLessThan(60);
    } finally {
      for (const edge of edges) {
        edge.dispose();
      }
    }
  });
});
