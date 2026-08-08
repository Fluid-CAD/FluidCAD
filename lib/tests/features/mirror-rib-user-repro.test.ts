import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import plane from "../../core/plane.js";
import repeat from "../../core/repeat.js";
import rib from "../../core/rib.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { rect, circle, vLine } from "../../core/2d/index.js";
import { Rib } from "../../features/rib.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { ShapeOps } from "../../oc/shape-ops.js";

// User repro (Lego brick): mirroring a normal-mode extended rib whose sketch
// sits on an OFFSET derived plane — p = plane(sh.internalFaces(1), 6.3).
// PlaneFromObject.createCopy used to re-pass optionsOrPosition while wrapping
// the already-resolved original as its source, so the clone applied the 6.3
// offset a second time (z = 2.1 → z = −4.2, below the brick). The mirrored
// rib then swept the whole cavity height and left fragments above the top
// face and outside the walls.
describe("repeat mirror of a rib sketched on an offset derived plane", () => {
  setupOC();

  it("clones the sketch plane without re-applying the plane offset", () => {
    const thickness = 9.6;
    const width = 31.8;
    const height = 15.8;

    sketch("xy", () => {
      rect(width, height);
    });
    const e = extrude(thickness);

    sketch(e.endFaces(), () => {
      circle([3.9, (height - 8) / 2], 4.8);
    });
    const e2 = extrude(1.8);
    repeat("linear", ["x", "y"], { count: [4, 2], offset: [8, 8] }, e2);

    const sh = shell(-1.2, e.startFaces()).join("intersection");
    sketch(sh.internalFaces(1), () => {
      circle(6.51);
      circle(4.8);
    });
    const f = extrude(select(face().onPlane("xy")));
    repeat("linear", "x", { count: 3, offset: 8, centered: true }, f);

    // Cavity ceiling is at z = 8.4 with normal −z; the offset lands at z = 2.1.
    const p = plane(sh.internalFaces(1), 6.3);
    sketch(p, () => {
      vLine([15.9, -2], -1.67);
    });
    const f2 = rib(0.8).extend() as unknown as Rib;
    // Midplane of the two long side walls: y = 7.9.
    const p2 = plane(plane(e.sideFaces(1)), plane(e.sideFaces(3)));
    repeat("mirror", p2, f2 as unknown as SceneObject);

    render();

    const objs = getCurrentScene().getSceneObjects();
    const clones = objs.filter(o =>
      o instanceof Rib && o !== (f2 as unknown as SceneObject) &&
      (o as unknown as { getCloneSource: () => SceneObject | null }).getCloneSource() === (f2 as unknown as SceneObject),
    );
    expect(clones.length).toBe(1);
    const clone = clones[0];

    // The original rib starts on the sketch plane (z = 2.1) and runs up to the
    // cavity ceiling (z = 8.4), spanning y 1.2..~4.65 (outer wall to center
    // tube). The mirror flips y about 7.9 only — the clone must keep the same
    // z extents. Before the fix the clone had no start face at all (its
    // sketch plane sat at z = −4.2) and its walls ran from z = 0.
    const cloneStart = clone.getState("start-faces") as Face[];
    expect(cloneStart.length).toBeGreaterThan(0);
    const startBB = ShapeOps.getBoundingBox(cloneStart[0]);
    expect(startBB.minZ).toBeCloseTo(2.1, 1);
    expect(startBB.maxZ).toBeCloseTo(2.1, 1);

    const cloneSides = clone.getState("side-faces") as Face[];
    expect(cloneSides.length).toBeGreaterThan(0);
    for (const sideFace of cloneSides) {
      const bb = ShapeOps.getBoundingBox(sideFace);
      expect(bb.minZ).toBeGreaterThan(2.0);
      expect(bb.maxZ).toBeLessThan(8.5);
      expect(bb.minX).toBeGreaterThan(15.0);
      expect(bb.maxX).toBeLessThan(17.0);
      expect(bb.minY).toBeGreaterThan(11.0);
      expect(bb.maxY).toBeLessThan(14.7);
    }
  });
});
