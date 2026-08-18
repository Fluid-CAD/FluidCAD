import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import plane from "../../core/plane.js";
import { rect, slot } from "../../core/2d/index.js";
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

  it("skips closed section loops' endpoints but snaps their centers", () => {
    cylinder(5, 20);
    const mid = plane("top", 10) as IPlane;
    const s = sketch(mid, () => {}) as unknown as Sketch;

    const scene = render();
    const verts = scene.getRenderedObject(s)!.snapVertices!;
    // The mid-height section is a full circle — a closed loop with no model
    // crossing, so no endpoints — but its center is the cylinder axis, and
    // the rim circles' projected centers dedup onto the same point. The
    // projection pass adds the two seam vertices (both at x=r, y=0 → one
    // 2D point). Two snap targets total.
    expect(verts.length).toBe(2);

    const p = s.getPlane();
    for (const [wx, wy, wz] of [[0, 0, 10], [5, 0, 10]]) {
      const local = p.worldToLocal(new Point(wx, wy, wz));
      const hit = verts.some(v =>
        (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
      expect(hit, `expected a snap vertex at world (${wx}, ${wy}, ${wz})`).toBe(true);
    }
  });

  it("projects arc centers onto the plane", () => {
    sketch("top", () => {
      slot([-10, 0], [10, 0], 4);
    });
    extrude(5);

    const off = plane("top", 20) as IPlane;
    const s = sketch(off, () => {}) as unknown as Sketch;

    const scene = render();
    const verts = scene.getRenderedObject(s)!.snapVertices!;
    // The plane misses the body: 8 arc/line junction vertices project to 4
    // points, and the end-cap arcs at both z levels project their centers
    // onto the two cap-center points — where a concentric hole would go.
    expect(verts.length).toBe(6);

    const p = s.getPlane();
    for (const [wx, wy] of [[-10, 0], [10, 0]]) {
      const local = p.worldToLocal(new Point(wx, wy, 0));
      const hit = verts.some(v =>
        (v[0] - local.x) * (v[0] - local.x) + (v[1] - local.y) * (v[1] - local.y) < 1e-6);
      expect(hit, `expected the cap-arc center (${wx}, ${wy})`).toBe(true);
    }
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
