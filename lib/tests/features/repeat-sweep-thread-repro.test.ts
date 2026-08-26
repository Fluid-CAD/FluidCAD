import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import chamfer from "../../core/chamfer.js";
import helix from "../../core/helix.js";
import plane from "../../core/plane.js";
import sweep from "../../core/sweep.js";
import repeat from "../../core/repeat.js";
import { circle, line } from "../../core/2d/index.js";
import { FaceProps } from "../../oc/face-props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Solid } from "../../common/solid.js";
import { coincident, horizontal } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";

// A threaded through-hole is a helix sweep subtracted from a plain cut hole,
// leaving many small same-domain faces (thread flanks) around the bore. A
// later boolean on the same body used to run global UnifySameDomain, merging
// those faces away and reverting the thread to a plain cylinder. Count the
// cylindrical faces around each bore: a threaded bore has many, a plain one
// has ~1.
function cylinderCountByHole(): { atX0: number; atX50: number } {
  const scene = render();
  expect(scene.getAllSceneObjects().filter((o) => o.getError())).toEqual([]);

  // The final result and any snapshot copy of it are geometrically identical,
  // so take the max cylinder count seen in each bore bucket across all solids.
  let atX0 = 0;
  let atX50 = 0;
  for (const obj of scene.getAllSceneObjects()) {
    for (const s of obj.getShapes({}, "solid")) {
      if (!(s instanceof Solid)) {
        continue;
      }
      let x0 = 0;
      let x50 = 0;
      for (const f of s.getFaces()) {
        if (FaceProps.getProperties(f.getShape()).surfaceType !== "cylinder") {
          continue;
        }
        const bbox = ShapeOps.getBoundingBox(f);
        const cx = (bbox.minX + bbox.maxX) / 2;
        if (cx > 25) {
          x50++;
        } else if (cx > -25) {
          x0++;
        }
      }
      atX0 = Math.max(atX0, x0);
      atX50 = Math.max(atX50, x50);
    }
  }
  return { atX0, atX50 };
}

function threadedPlate() {
  sketch("xy", () => {
      testRect(160, 160, { at: [-80, -80] });
    });
  const e = extrude(25);
  sketch(e.endFaces(), () => {
    circle([0, 0], 30);
  });
  const c = cut();
  chamfer(3, e.endEdges());
  chamfer(3, e.startEdges());
  const h = helix(c.internalFaces()).turns(6).startOffset(-5).endOffset(5);
  const p = plane(h, 0);
  sketch(p, () => {
      const sg1 = line([-0.01, -3.37], [2.69, 4.11]);
      const sg2 = line([2.69, 4.11], [-2.63, 4.11]);
      const sg3 = line([-2.63, 4.11], [-0.01, -3.37]);
      coincident(sg1.end(), sg2.start());
      horizontal(sg2);
      coincident(sg2.end(), sg3.start());
      coincident(sg3.end(), sg1.start());
    });
  return { e, h, p, sweepFeature: sweep(h).remove() };
}

describe("thread survives a later boolean on the same body", () => {
  setupOC();

  it("linear-repeating the thread keeps both bores threaded", () => {
    const { h, p, sweepFeature } = threadedPlate();
    repeat("linear", "x", { count: 2, length: 50 }, h, sweepFeature, p);

    const { atX0, atX50 } = cylinderCountByHole();
    // Both bores threaded → many cylindrical bands each, not a lone plain wall.
    expect(atX0).toBeGreaterThan(3);
    expect(atX50).toBeGreaterThan(3);
  });

  it("a manual second cut does not strip the first bore's thread", () => {
    const { e } = threadedPlate();
    sketch(e.endFaces(), () => {
      circle([50, 0], 30);
    });
    cut();

    const { atX0 } = cylinderCountByHole();
    expect(atX0).toBeGreaterThan(3);
  });
});
