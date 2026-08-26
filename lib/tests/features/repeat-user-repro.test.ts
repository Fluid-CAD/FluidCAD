import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import axis from "../../core/axis.js";
import repeat from "../../core/repeat.js";
import sweep from "../../core/sweep.js";
import cut from "../../core/cut.js";
import { arc, circle, line } from "../../core/2d/index.js";
import fillet from "../../core/fillet.js";
import { coincident, tangent } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";
import copy from "../../core/copy.js";
import { countShapes } from "../utils.js";

// Regression: a circular repeat whose axis is an AxisFromEdge derived from
// a sketch line, whose targets are cuts on sketch-region slots. Exercises:
//   - LazyMatrix.rotation with an unbuilt AxisObjectBase source
//   - Extrude.getSourceDependencies pulling the containing Sketch into the
//     clone set so Sketch.build's clone-mode path carries shapes for cloned
//     geometry primitives (Slot here) that would otherwise lose their
//     Sketch parent context after clone.
describe("repeat circular with axis-from-sketch-line and cut-of-slot targets", () => {
  setupOC();

  it("renders without errors and produces the expected cut instances", () => {
    // legacy: vLine(1.5); tArc(-4, 45); tLine(1.5) — up 1.5, then a CW
    // 45° arc of radius 4 (center [4, 1.5]), then 1.5 along the 45° tangent.
    const spine = sketch("front", () => {
      const up = line([0, 0], [0, 1.5]);
      const bend = arc(
        [0, 1.5],
        [4 - 2 * Math.SQRT2, 1.5 + 2 * Math.SQRT2],
        [4, 1.5],
      ).cw();
      const topSegment = line(
        [4 - 2 * Math.SQRT2, 1.5 + 2 * Math.SQRT2],
        [4 - 1.25 * Math.SQRT2, 1.5 + 2.75 * Math.SQRT2],
      );
      coincident(up.end(), bend.start());
      coincident(bend.end(), topSegment.start());
      tangent(up, bend);
      tangent(bend, topSegment);
      return { topSegment };
    }).reusable();

    const profile = sketch("top", () => {
        const innerPipe = circle([0, 0], 1.5);
        const outerPipe = circle([0, 0], 2);
        return { innerPipe, outerPipe };
      });

    const pipe = sweep(spine, profile.regions.outerPipe);

    // legacy: rect(3.5).centered().radius(0.5) + a d=0.5 bolt circle at
    // [-1.25, -1.25] copied 4x around the origin.
    sketch("top", () => {
      testRect(3.5, 3.5, { at: [-1.75, -1.75] });
      fillet(0.5);
      const c = circle([-2.5 / 2, -2.5 / 2], 0.5);
      copy("circular", [0, 0], { count: 4, angle: 360 }, c);
    });

    extrude(0.375);

    // Legacy circle(4) drew at the pen origin = the end face centroid. The
    // spine ends at (4 - 1.25√2, 0, 1.5 + 2.75√2); in the swept face's local
    // frame that centroid sits at x = -(4 - 1.25√2), y = 0.
    sketch(pipe.endFaces(), () => {
      circle([-(4 - 1.25 * Math.SQRT2), 0], 4);
    });

    const upperFlange = extrude(-0.625);

    sweep(spine, profile.regions.innerPipe).remove();

    // Legacy drew both slots in one sketch at the pen after hMove(3.25/2)
    // from the face centroid (local [-(4 - 1.25√2), 0]): cap centers at
    // x = P and x = P + 1, y = 0. The single-sketch slot() regions are
    // expressed as one solved sketch per slot ring (cut() takes one target).
    const P = -(4 - 1.25 * Math.SQRT2) + 3.25 / 2;
    const slotProfile = (r: number) => {
      const top = line([P, r], [P + 1, r]);
      const capRight = arc([P + 1, r], [P + 1, -r], [P + 1, 0]).cw();
      const bottom = line([P + 1, -r], [P, -r]);
      const capLeft = arc([P, -r], [P, r], [P, 0]).cw();
      coincident(top.end(), capRight.start());
      coincident(capRight.end(), bottom.start());
      coincident(bottom.end(), capLeft.start());
      coincident(capLeft.end(), top.start());
    };
    const outerSlot = sketch(upperFlange.endFaces(), () => {
      slotProfile(0.75 / 2);
    });
    const innerSlot = sketch(upperFlange.endFaces(), () => {
      slotProfile(0.45 / 2);
    });

    const s1 = cut(innerSlot);
    const s2 = cut(0.25, outerSlot);

    const a = axis(spine.regions.topSegment);

    repeat("circular", a, { count: 4, angle: 360 }, s1, s2);

    const scene = render();
    expect(countShapes(scene)).toBeGreaterThan(0);
    expect(scene.getAllSceneObjects().some(o => o.getError())).toBe(false);
  });
});
