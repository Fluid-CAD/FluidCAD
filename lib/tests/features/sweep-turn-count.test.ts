import { describe, expect, it } from "vitest";
import { circle, line } from "../../core/2d/index.js";
import { angle, coincident, diameter, distance, horizontal, symmetric } from "../../core/constraints/index.js";
import extrude from "../../core/extrude.js";
import helix from "../../core/helix.js";
import { origin, yAxis } from "../../core/index.js";
import part from "../../core/part.js";
import plane from "../../core/plane.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SweepOps } from "../../oc/sweep-ops.js";
import { getOC } from "../../oc/init.js";
import { render, setupOC } from "../setup.js";
import { analyticRemovedVolume, boundaryError, orientationFixture, SECTION_TOLERANCE } from "../helpers/sweep-orientation.js";

/** Exact constraints and guesses from the user's box.part.js, including its part scope. */
function model(turns: number) {
  part("Box", () => {
    const stockProfile = sketch("xy", () => {
      const c = circle([0, 0], 50);
      coincident(c.center(), origin()); diameter(c, 50);
    }).close();
    const stock = extrude(120, stockProfile);
    const path = helix(stock.sideFaces()).turns(turns).startOffset(-10).endOffset(10);
    const profile = sketch(plane(path, 0), () => {
      const a = line([2.5, -2.11], [-2.5, -2.11]);
      const b = line([-2.5, -2.11], [-1.16, 2.89]);
      const c = line([-1.16, 2.89], [1.16, 2.89]);
      const d = line([1.16, 2.89], [2.5, -2.11]);
      coincident(c.start(), b.end()); horizontal(c); coincident(d.start(), c.end());
      angle(b.start(), d, 30); symmetric(d.start(), b.end(), yAxis()); distance(c, a, 5);
      coincident(b.start(), a.end()); coincident(d.end(), a.start()); horizontal(a);
      distance(a.start(), a.end(), 5); symmetric(a.start(), b.start(), yAxis()); distance(c, origin(), 1);
    }).close();
    sweep(path, profile).remove();
  });
}

describe("subtractive helix turn-count regression", () => {
  setupOC();

  it("removes the analytic groove after 5 → 10 → fractional → 10 turn edits", () => {
    let previous: ReturnType<typeof render> | undefined;
    for (const turns of [5, 10, 7.5, 10]) {
      const next = getSceneManager().startScene();
      model(turns);
      if (previous) SceneCompare.compare(previous, next);
      previous = render();
      const objects = previous.getAllSceneObjects();
      expect(objects.filter(o => o.getError()).map(o => o.getError())).toEqual([]);
      const stock = objects.find(o => o.getType() === "extrude")!.getAddedShapes()[0];
      const feature = objects.find(o => o.getType() === "sweep")!;
      expect(feature.getShapes()).toHaveLength(1);
      const validation = ShapeValidator.validate(feature.getShapes()[0].getShape());
      expect(validation.findings).toEqual([]);
      expect(validation.solids).toBe(1);
      const stockVolume = Math.PI * 25 ** 2 * 120;
      expect(Math.abs(ShapeValidator.signedVolume(stock.getShape()) - stockVolume)).toBeLessThan(1e-5);
      const expected = stockVolume - analyticRemovedVolume(40000, 140 / turns);
      expect(Math.abs(validation.solidVolumes[0] - expected), `${turns} turns retained volume`).toBeLessThan(0.05);
      const oc = getOC();
      const classifier = new oc.BRepClass3d_SolidClassifier(feature.getShapes()[0].getShape());
      try {
        for (const fraction of [0.13, 0.39, 0.71]) {
          const angle = -2 * Math.PI * turns * fraction;
          for (const radius of [24.5, 23.5]) {
            const point = new oc.gp_Pnt(radius * Math.cos(angle), radius * Math.sin(angle), -10 + 140 * fraction);
            try {
              classifier.Perform(point, 1e-6);
              expect(classifier.State()).toBe(radius === 24.5 ? oc.TopAbs_State.TopAbs_OUT : oc.TopAbs_State.TopAbs_IN);
            } finally { point.delete(); }
          }
        }
      } finally { classifier.delete(); }
    }
  });

  it("keeps the ten-turn cutter on the analytic screw surface after bounding its faces", () => {
    const fixture = orientationFixture(14, 10);
    const result = SweepOps.buildResolved(fixture.automatic);
    try {
      const raw = result.solids[0].getShape();
      expect(ShapeValidator.validate(raw).findings).toEqual([]);
      expect(boundaryError(fixture, raw)).toBeLessThanOrEqual(SECTION_TOLERANCE);
    } finally {
      result.solids.forEach(s => s.dispose()); result.firstShape.delete(); result.lastShape.delete(); fixture.dispose();
    }
  });
});
