import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import axis from "../../core/axis.js";
import repeat from "../../core/repeat.js";
import sweep from "../../core/sweep.js";
import cut from "../../core/cut.js";
import { rect, circle, vLine, tArc, tLine, slot, move, hMove } from "../../core/2d/index.js";
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
    const spine = sketch("front", () => {
      vLine(1.5);
      tArc(-4, 45);
      const topSegment = tLine(1.5);
      return { topSegment };
    }).reusable();

    const profile = sketch("top", () => {
      const innerPipe = circle(1.5);
      const outerPipe = circle(2);
      return { innerPipe, outerPipe };
    });

    const pipe = sweep(spine, profile.regions.outerPipe);

    sketch("top", () => {
      rect(3.5).centered().radius(0.5);
      move([-2.5 / 2, -2.5 / 2]);
      const c = circle(0.5);
      copy("circular", [0, 0], { count: 4, angle: 360 }, c);
    });

    extrude(0.375);

    sketch(pipe.endFaces(), () => {
      circle(4);
    });

    const upperFlange = extrude(-0.625);

    sweep(spine, profile.regions.innerPipe).remove();

    const slots = sketch(upperFlange.endFaces(), () => {
      hMove(3.25 / 2);
      const outerSlot = slot(1, 0.75 / 2);
      const innerSlot = slot(1, 0.45 / 2);
      return { outerSlot, innerSlot };
    });

    const s1 = cut(slots.regions.innerSlot);
    const s2 = cut(0.25, slots.regions.outerSlot);

    const a = axis(spine.regions.topSegment);

    repeat("circular", a, { count: 4, angle: 360 }, s1, s2);

    const scene = render();
    expect(countShapes(scene)).toBeGreaterThan(0);
    expect(scene.getAllSceneObjects().some(o => o.getError())).toBe(false);
  });
});
