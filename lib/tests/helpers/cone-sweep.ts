import { circle, line } from "../../core/2d/index.js";
import { angle, coincident, diameter, distance, horizontal, symmetric } from "../../core/constraints/index.js";
import extrude from "../../core/extrude.js";
import helix from "../../core/helix.js";
import { origin, yAxis } from "../../core/index.js";
import part from "../../core/part.js";
import plane from "../../core/plane.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";

/** Exact constraints and guesses from the user's five-turn drafted-cone report. */
export function coneSweepModel(turns = 5, draft = 8, withSweep = true, operation: "remove" | "new" | "add" = "remove") {
  part("Box", () => {
    const s = sketch("xy", () => {
      const c1 = circle([0, 0], 50);
      coincident(c1.center(), origin()); diameter(c1, 50);
    }).close();
    const e = extrude(50, s).draft(draft);
    const e2 = helix(e.sideFaces()).turns(turns).startOffset(-10).endOffset(10);
    const p = plane(e2, 0);
    const s2 = sketch(p, () => {
      const l1 = line([2.5, -2.11], [-2.5, -2.11]);
      const l2 = line([-2.5, -2.11], [-1.16, 2.89]);
      const l3 = line([-1.16, 2.89], [1.16, 2.89]);
      const l4 = line([1.16, 2.89], [2.5, -2.11]);
      coincident(l3.start(), l2.end()); horizontal(l3); coincident(l4.start(), l3.end());
      angle(l2.start(), l4, 30); symmetric(l4.start(), l2.end(), yAxis()); distance(l3, l1, 5);
      coincident(l2.start(), l1.end()); coincident(l4.end(), l1.start()); horizontal(l1);
      distance(l1.start(), l1.end(), 5); symmetric(l1.start(), l2.start(), yAxis()); distance(l3, origin(), 2);
    }).close();
    if (withSweep) sweep(e2, s2)[operation]();
  });
}

/** Exact stock volume in mm³, independent of the kernel and its boolean result. */
export function coneStockVolume(draft = 8): number {
  const topRadius = 25 + 50 * Math.tan(draft * Math.PI / 180);
  return Math.PI * 50 / 3 * (25 ** 2 + 25 * topRadius + topRadius ** 2);
}
