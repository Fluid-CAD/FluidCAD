import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import plane from "../../../core/plane.js";
import { project, arc, connect, move } from "../../../core/2d/index.js";
import { edge } from "../../../filters/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Edge } from "../../../common/edge.js";
import { EdgeOps } from "../../../oc/edge-ops.js";
import { PlaneObjectBase } from "../../../features/plane-renderable-base.js";

describe("project — user regression (symmetric arc extrude onto offset front plane)", () => {
  setupOC();

  it("projects arc end-edges of a symmetric extrude onto an offset front plane", () => {
    sketch("front", () => {
      arc(31);
      connect();
      move([0, 0]);
    });
    const circleExtrude = extrude(66).symmetric() as Extrude;

    const p = plane("front", { offset: 20 }) as unknown as PlaneObjectBase;

    const s = sketch(p, () => {
      project(circleExtrude.endEdges(edge().arc()));
    }) as Sketch;

    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);

    // Every projected edge must lie on the target plane `p`. Use the plane's
    // containsPoint check to avoid hardcoding coordinate-system assumptions.
    const targetPlane = p.getPlane();
    for (const shape of shapes) {
      if (shape instanceof Edge) {
        const mid = EdgeOps.getEdgeMidPoint(shape);
        const dist = targetPlane.distanceToPoint(mid);
        expect(dist).toBeLessThan(1e-4);
      }
    }
  });
});
