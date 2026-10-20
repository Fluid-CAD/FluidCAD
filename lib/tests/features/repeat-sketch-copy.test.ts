import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import axis from "../../core/axis.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import { project } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";
import { testRect } from "../helpers/profiles.js";

// Regression: repeating a cut whose sketch holds a 2D copy() cloned the
// copy statement — and the axis() it walks along — and neither had a
// createCopy, so the repeat threw "createCopy() not implemented for axis"
// (then "… for copy-linear" once the axis was copyable).
describe("repeat of a cut whose sketch holds a 2D copy", () => {
  setupOC();

  const box = 200 * 200 * 20;
  const pocket = 5 * 5 * 5;

  function solidVolumes(scene: Scene): number[] {
    return scene.getSceneObjects()
      .filter(o => !o.isContainer())
      .flatMap(o => o.getShapes())
      .filter(sh => sh.isSolid())
      .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3);
  }

  function expectPockets(scene: Scene, count: number) {
    const errors = scene.getSceneObjects()
      .map(o => ({ type: o.getType(), err: o.getError() }))
      .filter(e => e.err);
    expect(errors).toEqual([]);

    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(1);
    expect(volumes[0]).toBeCloseTo(box - count * pocket, 0);
  }

  function base() {
    sketch("xy", () => {
      testRect(200, 200, { at: [-100, -100] });
    });
    return extrude(20);
  }

  it("copies along a sketch axis", () => {
    const e = base();
    const s = sketch(e.endFaces(), () => {
      const r = testRect(5, 5);
      copy("linear", "x", { count: 3, offset: 10 }, r.b, r.r, r.t, r.l);
    });
    const c = cut(5, s);
    repeat("linear", "x", { count: 2, offset: 50 }, c);

    expectPockets(render(), 6);
  });

  it("copies along an axis() of a projected edge", () => {
    const e = base();
    const s = sketch(e.endFaces(), () => {
      const p = project(e.endEdges(edge().parallelTo("yz").farthest("x"))).guide();
      const r = testRect(5, 5);
      copy("linear", axis(p), { count: 3, offset: 10 }, r.b, r.r, r.t, r.l);
    });
    const c = cut(5, s);
    repeat("linear", "x", { count: 2, offset: 50 }, c);

    expectPockets(render(), 6);
  });

  it("copies along the axis midway between two axes", () => {
    const e = base();
    const s = sketch(e.endFaces(), () => {
      const r = testRect(5, 5);
      copy("linear", axis(axis(r.l), axis(r.r)), { count: 3, offset: 10 }, r.b, r.r, r.t, r.l);
    });
    const c = cut(5, s);
    repeat("linear", "x", { count: 2, offset: 50 }, c);

    expectPockets(render(), 6);
  });

  it("copies around a center", () => {
    const e = base();
    const s = sketch(e.endFaces(), () => {
      const r = testRect(5, 5, { at: [10, 10] });
      copy("circular", [0, 0], { count: 4, angle: 360 }, r.b, r.r, r.t, r.l);
    });
    const c = cut(5, s);
    repeat("linear", "x", { count: 2, offset: 50 }, c);

    expectPockets(render(), 8);
  });
});
