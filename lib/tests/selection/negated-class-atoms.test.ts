import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import type { PickRef } from "../../selection/types.js";
import { findSolid, setLocation } from "./pick-helpers.js";

// The gear with its vertical flanks already filleted: the prior fillet
// reshapes the rim arcs (lineage picks) and adds BSpline transition edges
// (curveType 'other'), so no positive curve-class atom is shared across the
// rim — and every shared positive property also holds for the coplanar bore
// circle. Only a negated class atom (.notCircle()) can express the rim.
describe("negated class atoms", () => {
  setupOC();

  it("fillet on the top rim after a prior fillet reshaped it", () => {
    sketch("xy", () => {
      circle(72);
    });
    const body = extrude(34) as Extrude;
    setLocation(body, 4);

    sketch(body.endFaces(), () => {
      circle(30);
    });
    const bore = cut();
    setLocation(bore, 9);

    sketch(body.endFaces(), () => {
      circle([36, 0], 16);
    });
    const flute = cut();
    setLocation(flute, 14);

    const r = repeat("circular", "z", { count: 8, angle: 360 }, flute);
    setLocation(r, 16);

    const f = fillet(4, select(edge().line()));
    setLocation(f, 17);

    const scene = render();
    const solid = findSolid(scene);

    // The whole top rim: every non-line edge at z=34 except the bore circle.
    const refs: PickRef[] = [];
    Explorer.findEdgesWrapped(solid).forEach((e, index) => {
      const props = EdgeProps.getProperties(e.getShape());
      const mid = EdgeOps.getEdgeMidPoint(e);
      if (props.curveType === "line" || Math.abs(mid.z - 34) > 1e-6) {
        return;
      }
      const rr = Math.hypot(mid.x, mid.y);
      if (Math.abs(rr - 15) < 0.01) {
        return; // bore circle
      }
      refs.push({ shapeId: solid.id, sub: { type: "edge", index } });
    });
    expect(refs).toHaveLength(32);

    const result = synthesizeApplyFeature(scene, refs, "fillet", 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(1, select(edge().onPlane(e.endFaces()).notCircle()))");
    }
  });
});
