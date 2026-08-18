import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import plane from "../../core/plane.js";
import { rect } from "../../core/2d/index.js";
import part from "../../core/part.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Point } from "../../math/point.js";
import { IPlane } from "../../core/interfaces.js";

describe("sketch snap vertices", () => {
  setupOC();

  it("attaches plane-crossing endpoints to the tip sketch", () => {
    sketch("top", () => {
      rect(20, 10).centered();
    });
    extrude(10);

    const front = sketch("front", () => {}) as unknown as Sketch;

    const scene = render();
    const rendered = scene.getRenderedObject(front);
    const verts = rendered!.snapVertices!;
    expect(verts).toBeDefined();
    // The front plane (y=0) cuts the 20x10x10 box in a rectangle whose
    // corners sit at x=±10, z∈{0,10} — and all 8 box corners project onto
    // those same 4 points, so the dedup between the two sources holds too.
    expect(verts.length).toBe(4);

    const p = front.getPlane();
    for (const [wx, wy, wz] of [[-10, 0, 0], [10, 0, 0], [-10, 0, 10], [10, 0, 10]]) {
      const local = p.worldToLocal(new Point(wx, wy, wz));
      const hit = verts.some(v =>
        (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
      expect(hit, `expected a snap vertex at world (${wx}, ${wy}, ${wz})`).toBe(true);
    }
  });

  it("projects body vertices onto a plane the body never touches", () => {
    sketch("top", () => {
      rect(20, 10).centered();
    });
    extrude(10);

    const off = plane("front", 20) as IPlane;
    const s = sketch(off, () => {}) as unknown as Sketch;

    const scene = render();
    const verts = scene.getRenderedObject(s)!.snapVertices!;
    expect(verts).toBeDefined();
    // No section exists — the plane misses the box — so these are purely the
    // 8 corners projected along the normal, collapsing to 4 distinct points.
    expect(verts.length).toBe(4);

    const p = s.getPlane();
    for (const wx of [-10, 10]) {
      for (const wy of [-5, 5]) {
        for (const wz of [0, 10]) {
          const local = p.worldToLocal(new Point(wx, wy, wz));
          const hit = verts.some(v =>
            (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
          expect(hit, `expected the projection of corner (${wx}, ${wy}, ${wz})`).toBe(true);
        }
      }
    }
  });

  it("snaps to other parts' bodies when sketching inside a part", () => {
    part("donor", () => {
      sketch("top", () => {
        rect(20, 10).centered();
      });
      extrude(10);
    });

    let front: Sketch;
    part("consumer", () => {
      front = sketch("front", () => {}) as unknown as Sketch;
    });

    const scene = render();
    const verts = scene.getRenderedObject(front!)!.snapVertices!;
    expect(verts).toBeDefined();
    // Same geometry as the top-level case: the donor part's box crosses the
    // front plane in a rectangle at x=±10, z∈{0,10}, and its corners project
    // onto the same 4 points — part boundaries must not filter it out.
    expect(verts.length).toBe(4);

    const p = front!.getPlane();
    for (const [wx, wy, wz] of [[-10, 0, 0], [10, 0, 0], [-10, 0, 10], [10, 0, 10]]) {
      const local = p.worldToLocal(new Point(wx, wy, wz));
      const hit = verts.some(v =>
        (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
      expect(hit, `expected a snap vertex at world (${wx}, ${wy}, ${wz})`).toBe(true);
    }
  });

  it("skips closed section loops; only projected seam vertices remain", () => {
    cylinder(5, 20);
    const mid = plane("top", 10) as IPlane;
    const s = sketch(mid, () => {}) as unknown as Sketch;

    const scene = render();
    const verts = scene.getRenderedObject(s)!.snapVertices!;
    // The mid-height section is a full circle — a closed loop with no model
    // crossing, so it contributes nothing. What remains is the projection of
    // the cylinder's two seam vertices (both at x=r, y=0), one point in 2D.
    expect(verts.length).toBe(1);
    const seam = s.getPlane().worldToLocal(new Point(5, 0, 0));
    expect(verts[0][0]).toBeCloseTo(seam.x);
    expect(verts[0][1]).toBeCloseTo(seam.y);
  });

  it("leaves renders whose tip is not a sketch untouched", () => {
    sketch("top", () => {
      rect(20, 10).centered();
    });
    extrude(10);

    const scene = render();
    for (const rendered of scene.getRenderedObjects()) {
      expect(rendered.snapVertices).toBeUndefined();
    }
  });
});
