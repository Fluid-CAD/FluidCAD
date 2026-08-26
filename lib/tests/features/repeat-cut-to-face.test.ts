import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import { circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";

// Regression: repeating a cut bounded by a face of the base body
// (`cut(e.startFaces())`) used to clone the base body's whole producer chain
// into every instance — each clone re-extruded the full base over the previous
// instances' results and cut a single hole, leaving one hole at the last angle
// instead of N. The up-to-face selection is a boundary dependency now: the
// selection itself is cloned (its shapes are consumed per build) but its
// producer is referenced, not rebuilt.
describe("repeat circular of a cut bounded by the base body's face", () => {
  setupOC();

  function solidVolumes(scene: Scene): number[] {
    return scene.getSceneObjects()
      .filter(o => !o.isContainer())
      .flatMap(o => o.getShapes())
      .filter(sh => sh.isSolid())
      .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3)
      .sort((a, b) => a - b);
  }

  it("stamps the cut per instance instead of rebuilding the base body", () => {
    sketch("xy", () => {
        circle([0, 0], 100);
      });
    const e = extrude(50).new() as ExtrudeBase;

    sketch(e.endFaces(), () => {
      circle([20, 20], 20);
    });
    cut(e.startFaces());

    repeat("circular", "z", { count: 4, angle: 360 });

    const scene = render();

    const errors = scene.getSceneObjects()
      .map(o => ({ type: o.getType(), err: o.getError() }))
      .filter(e => e.err);
    expect(errors).toEqual([]);

    // One body: the cylinder with all 4 holes — not a per-instance rebuild
    // where the last clone's fresh cylinder plugged the earlier holes.
    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(1);

    const cylinder = Math.PI * 50 * 50 * 50;
    const hole = Math.PI * 10 * 10 * 50;
    expect(volumes[0]).toBeCloseTo(cylinder - 4 * hole, 0);
  });
});
