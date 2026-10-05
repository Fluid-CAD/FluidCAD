import { describe, it, expect, afterEach, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, ellipse, extrude, loft, fillet, plane } from "../../core/index.js";
import { Loft } from "../../features/loft.js";
import { Extrude } from "../../features/extrude.js";
import { Solid } from "../../common/solid.js";
import { BooleanOps } from "../../oc/boolean-ops.js";
import { testRect } from "../helpers/profiles.js";

/**
 * A BOP can come back empty without an error flag: it marks the inputs
 * deleted and returns no solid (OCC did this for a strongly skewed
 * ThruSections loft fused into a sweep body). The feature must refuse that
 * result: it records an error and the existing solid stays in the scene,
 * instead of the scene silently emptying (which made every later selection
 * resolve to nothing). The empty result is forced on the kernel call here —
 * the in-house loft skin no longer trips the kernel on that geometry.
 */
describe("fuse with an empty kernel result", () => {
  setupOC();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records an error on the feature and keeps the existing solid", () => {
    sketch("xy", () => testRect(30, 20, { at: [-15, -10] }));
    const pad = extrude(6) as Extrude;
    const footBase = sketch(plane("xy", 6), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
    const footTop = sketch(plane("xy", 18), () => ellipse([0, 0], 5, 7));
    const foot = loft(footBase, footTop) as Loft;

    vi.spyOn(BooleanOps, "fuseStockAndTools").mockImplementation(stock => ({
      result: [],
      modifiedShapes: [...stock],
      newShapes: [],
      maker: { HasErrors: () => false },
      dispose: () => {},
    }));

    render();

    expect(foot.getError()).toMatch(/returned no solid/);
    expect(foot.getShapes()).toHaveLength(0);
    // The body built so far is still in the scene, owned by the feature that built it.
    const kept = pad.getShapes();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBeInstanceOf(Solid);
  });
});
