import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import repeat from "../../core/repeat.js";
import fillet from "../../core/fillet.js";
import { hLine, vLine, circle } from "../../core/2d/index.js";
import { countShapes } from "../utils.js";

// Regression: circular-repeating a sweep whose PATH is a bare curve borrowed
// from another sketch (`pathSketch.regions.corner`). cloneWithTransform used to
// deep-clone the path's 2D source chain (the fillet and the lines behind it)
// out of its sketch and parent it under the repeat container. With no Sketch
// ancestor those clones threw "Cannot read properties of null (reading
// 'getPlane')". The borrowed path is now frozen into a transformed shape clone
// instead of being rebuilt.
describe("repeat circular of a sweep with a borrowed in-sketch path", () => {
  setupOC();

  it("renders every instance without orphaning the path's 2D source curves", () => {
    const pathSketch = sketch("front", () => {
      const up = vLine(20);
      const across = hLine(20);
      const corner = fillet(5, up, across).reusable();
      return { corner };
    });

    sketch("top", () => {
      circle(2);
    });

    const s1 = sweep(pathSketch.regions.corner);

    repeat("circular", "z", { count: 3, angle: 360 }, s1);

    const scene = render();

    const errored = scene.getAllSceneObjects().filter(o => o.getError());
    expect(errored.map(o => `${o.getType()}: ${o.getError()}`)).toEqual([]);
    expect(countShapes(scene)).toBeGreaterThan(0);
  });
});
