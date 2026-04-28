import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import { rect, intersect, offset } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";

describe("thin extrude offset auto-fix", () => {
  setupOC();

  it("falls back to face-spine offset when wire-spine offset fails", () => {
    // The drafted body's filleted corners produce GeomAbs_OffsetCurve edges
    // when sectioned at z=0 and offset by -6. BRepOffsetAPI_MakeOffset's
    // wire-spine path can't re-offset that wire (it throws "Offset wire is
    // not closed."), but the face-spine path can — ThinFaceMaker.doOffset
    // should retry on failure.
    sketch("top", () => {
      rect(205, 133).centered();
    });
    const body = extrude(100).draft(10) as Extrude;
    fillet(32, body.sideEdges());

    const s = select(edge().onPlane("top")) as SelectSceneObject;
    sketch("bottom", () => {
      intersect(s);
      offset(-6, true);
    });

    const thin = extrude(5).thin(1.25, 1.25) as Extrude;

    render();

    expect(thin.getError()).toBeNull();
    const shapes = thin.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes[0].getType()).toBe('solid');
  });
});
