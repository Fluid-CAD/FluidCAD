import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { Extrude } from "../../features/extrude.js";
import { Loft } from "../../features/loft.js";
import { Face } from "../../common/face.js";
import { Plane, StandardPlane, toPlane } from "../../math/plane.js";
import { Vector3d } from "../../math/vector3d.js";
import { getSceneManager } from "../../scene-manager.js";

/**
 * A face's sketch frame used to take its X from the surface's own `gp_Ax3`
 * while taking Z from the *orientation-corrected* face normal. Those two
 * disagree whenever the face is TopAbs_REVERSED — which a prism's start cap
 * always is — so the frame came out rotated 180° about the normal and a
 * sketch on it rendered upside down (yDirection pointing at world −Z).
 * Faces that fall back to BRepBuilderAPI_FindPlane were worse still: that X
 * is a least-squares fit, skewed at an arbitrary angle.
 *
 * The frame is now derived from the normal alone — see Plane.upright.
 */
describe("face plane frame", () => {
  setupOC();

  function capsOf(p: StandardPlane): { start: Face; end: Face } {
    getSceneManager().startScene();
    sketch(p, () => { testRect(40, 20); });
    const e = extrude(15) as unknown as Extrude;
    const startSel = e.startFaces();
    const endSel = e.endFaces();
    addToScene(startSel);
    addToScene(endSel);
    render();
    return { start: startSel.getShapes()[0] as Face, end: endSel.getShapes()[0] as Face };
  }

  const STANDARD: StandardPlane[] = ["xy", "xz", "yz", "-xy", "-xz", "-yz"];

  it("gives both extrude caps a world-up Y on every vertical sketch plane", () => {
    for (const p of (["xz", "yz", "-xz", "-yz"] as StandardPlane[])) {
      const { start, end } = capsOf(p);
      // Both caps are vertical, so "up" is unambiguously world +Z.
      expect(start.getPlane().yDirection.z).toBeCloseTo(1);
      expect(end.getPlane().yDirection.z).toBeCloseTo(1);
    }
  });

  it("gives a face lying in a standard plane that standard plane's own frame", () => {
    for (const p of STANDARD) {
      const { start, end } = capsOf(p);
      // The end cap faces along the sketch plane's normal, the start cap
      // against it — so they match that standard plane and its reverse.
      const forward = toPlane(p);
      const reversed = forward.reverse();

      for (const [face, expected] of [[end, forward], [start, reversed]] as const) {
        const actual = face.getPlane();
        expect(actual.normal.dot(expected.normal)).toBeCloseTo(1);
        expect(actual.xDirection.dot(expected.xDirection)).toBeCloseTo(1);
        expect(actual.yDirection.dot(expected.yDirection)).toBeCloseTo(1);
      }
    }
  });

  it("keeps the frame upright on a flat wall recovered by plane fitting", () => {
    // OCC stores a rect→rect loft's flat walls as B-splines, so their plane
    // comes from BRepBuilderAPI_FindPlane, whose X direction is arbitrary.
    const s1 = sketch("xy", () => { testRect(120, 80, { at: [-60, -40] }); });
    const s2 = sketch(plane("xy", 50), () => { testRect(60, 40, { at: [-30, -20] }); });
    const lf = loft(s1, s2) as unknown as Loft;
    render();

    const walls = (lf as any).getState("side-faces") as Face[];
    expect(walls).toHaveLength(4);
    for (const wall of walls) {
      const frame = wall.getPlane();
      // Every wall is tilted, so Y must be the in-plane steepest ascent:
      // world +Z projected onto the wall.
      const n = frame.normal.normalize();
      const expectedUp = Vector3d.unitZ().subtract(n.multiply(n.dot(Vector3d.unitZ()))).normalize();
      expect(frame.yDirection.dot(expectedUp)).toBeCloseTo(1);
      expect(frame.xDirection.z).toBeCloseTo(0);
    }
  });

  it("matches the frame a connector on the same face gets", () => {
    // buildOrthonormalFrame (connectors, anchored vertices) and the sketch
    // plane must not disagree about which way is up on a given face.
    const { start } = capsOf("xz");
    const frame = start.getPlane();
    const connectorX = Plane.uprightXDirection(frame.normal);
    expect(frame.xDirection.dot(connectorX)).toBeCloseTo(1);
  });
});
