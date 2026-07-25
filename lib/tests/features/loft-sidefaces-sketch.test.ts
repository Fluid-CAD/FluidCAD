import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import { rect, circle } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { FaceOps } from "../../oc/face-ops.js";
import { PlaneFromObject } from "../../features/plane-from-object.js";
import { Face } from "../../common/face.js";

function planeFromObjectInScene(): PlaneFromObject | undefined {
  return getCurrentScene()
    .getAllSceneObjects()
    .find((o) => o instanceof PlaneFromObject) as PlaneFromObject | undefined;
}

describe("sketch on loft side face", () => {
  setupOC();

  // Regression: OCC stores the flat trapezoid walls of a rect→rect loft as
  // B-spline surfaces, so the GeomAbs_Plane check rejected them and
  // sketch(lf.sideFaces(n)) threw "Cannot read properties of undefined
  // (reading 'origin')". FaceOps now fits a plane to such flat faces.
  it("resolves a plane from a flat (B-spline) loft side wall", () => {
    const s1 = sketch("xy", () => {
      rect(120, 80).centered();
    });
    const s2 = sketch(plane("xy", 50), () => {
      rect(60, 40).centered();
    });
    const lf = loft(s1, s2) as Loft;
    render();

    const sideFaces = (lf as any).getState("side-faces") as Face[];
    expect(sideFaces).toHaveLength(4);
    for (const f of sideFaces) {
      expect(FaceOps.tryGetPlane(f)).not.toBeNull();
    }

    // The exact failing call from the bug report (empty sketcher).
    sketch(lf.sideFaces(2), () => {});
    expect(() => render()).not.toThrow();

    const planeObj = planeFromObjectInScene();
    expect(planeObj).toBeDefined();
    expect(planeObj!.getError()).toBeFalsy();
    expect(planeObj!.getPlane()).toBeTruthy();
  });

  // A genuinely curved wall (circle→circle loft) must still be rejected, and
  // that rejection must surface as a clean per-object error rather than
  // aborting the whole scene render with a null dereference.
  it("rejects a curved loft side wall cleanly without aborting the render", () => {
    const s1 = sketch("xy", () => {
      circle(80);
    });
    const s2 = sketch(plane("xy", 50), () => {
      circle(40);
    });
    const lf = loft(s1, s2) as Loft;
    render();

    const sideFaces = (lf as any).getState("side-faces") as Face[];
    for (const f of sideFaces) {
      expect(FaceOps.tryGetPlane(f)).toBeNull();
    }

    sketch(lf.sideFaces(0), () => {});
    // Whole-scene render must still complete (the loft itself keeps rendering).
    expect(() => render()).not.toThrow();

    const planeObj = planeFromObjectInScene();
    expect(planeObj).toBeDefined();
    expect(planeObj!.getError()).toMatch(/planar/i);
  });
});
