import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import plane from "../../core/plane.js";
import { rect } from "../../core/2d/index.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Point } from "../../math/point.js";
import { IPlane } from "../../core/interfaces.js";

describe("sketch section snap vertices", () => {
  setupOC();

  it("attaches plane-crossing endpoints to the tip sketch", () => {
    sketch("top", () => {
      rect(20, 10).centered();
    });
    extrude(10);

    const front = sketch("front", () => {}) as unknown as Sketch;

    const scene = render();
    const rendered = scene.getRenderedObject(front);
    const verts = rendered!.sectionSnapVertices!;
    expect(verts).toBeDefined();
    expect(verts.length).toBe(4);

    // The front plane (y=0) cuts the 20x10x10 box in a rectangle whose
    // corners sit at x=±10, z∈{0,10}.
    const p = front.getPlane();
    for (const [wx, wy, wz] of [[-10, 0, 0], [10, 0, 0], [-10, 0, 10], [10, 0, 10]]) {
      const local = p.worldToLocal(new Point(wx, wy, wz));
      const hit = verts.some(v =>
        (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
      expect(hit, `expected a snap vertex at world (${wx}, ${wy}, ${wz})`).toBe(true);
    }
  });

  it("skips closed section loops (no arbitrary seam vertex)", () => {
    cylinder(5, 20);
    const mid = plane("top", 10) as IPlane;
    const s = sketch(mid, () => {}) as unknown as Sketch;

    const scene = render();
    const rendered = scene.getRenderedObject(s);
    // The mid-height section of a cylinder is a full circle — a closed loop
    // with no model crossing, so nothing snappable comes of it.
    expect(rendered!.sectionSnapVertices).toBeUndefined();
  });

  it("leaves renders whose tip is not a sketch untouched", () => {
    sketch("top", () => {
      rect(20, 10).centered();
    });
    extrude(10);

    const scene = render();
    for (const rendered of scene.getRenderedObjects()) {
      expect(rendered.sectionSnapVertices).toBeUndefined();
    }
  });
});
