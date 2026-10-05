// Open sketch edges that end inside a closed region, and an in-sketch
// axis(l) whose display edge must stay out of the profile. Both used to
// leave INTERNAL edges on the region face and fault inside OCC ("memory
// access out of bounds") in the extrude's wire orientation check.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import copy from "../../core/copy.js";
import extrude from "../../core/extrude.js";
import { axis } from "../../core/index.js";
import { line, circle, ellipse } from "../../core/2d/index.js";
import { coincident, horizontal, vertical } from "../../core/constraints/index.js";
import { Explorer } from "../../oc/explorer.js";
import type { SceneObject } from "../../common/scene-object.js";

function extrudeResult() {
  const scene = render();
  const obj = scene.getSceneObjects().find(o => o.getUniqueType() === 'extrude-by-distance') as SceneObject;
  const solids = obj.getShapes();
  const faces = solids.reduce((n, s) => n + Explorer.findFacesWrapped(s).length, 0);
  return { error: obj.getError(), solids: solids.length, faces };
}

describe("regions with dangling sketch edges", () => {
  setupOC();

  it("extrudes a circle holding a line that ends inside it", () => {
    sketch('xz', () => {
      circle([0, 0], 5);
      line([0, 0], [0, 2]);
    });
    extrude(10);
    expect(extrudeResult()).toEqual({ error: null, solids: 1, faces: 3 });
  });

  it("extrudes a circle crossed by a line starting at its centre", () => {
    sketch('xz', () => {
      circle([0, 0], 5);
      line([0, 0], [0, 20]);
    });
    extrude(10);
    expect(extrudeResult()).toEqual({ error: null, solids: 1, faces: 3 });
  });

  it("keeps an in-sketch axis(l) out of the copied profile", () => {
    sketch('xz', () => {
      const c = circle([0, 0], 5);
      const l = line([20, 0], [20, 20]);
      copy('linear', axis(l), { count: 3, offset: 30 }, c);
    });
    extrude(10);
    // Three whole cylinders: the axis's 600 mm display edge no longer
    // slices each copy in half.
    expect(extrudeResult()).toEqual({ error: null, solids: 3, faces: 9 });
  });

  it("extrudes a 12x12 ellipse copy along two sketched lines (user repro)", () => {
    sketch('xz', () => {
      const el1 = ellipse([-64.48, 34.44], 9.37, 14.44);
      const l1 = line([-64.48, 34.44], [-13.23, 34.44]);
      const l2 = line([-64.48, 34.44], [-64.48, 76.6]);
      coincident(l1.start(), el1.center());
      horizontal(l1);
      coincident(l2.start(), el1.center());
      vertical(l2);
      copy('linear', [axis(l1), axis(l2)], { count: [12, 12], offset: [20, 30] }, el1);
    });
    extrude(25);
    const result = extrudeResult();
    expect(result.error).toBeNull();
    expect(result.solids).toBe(144);
  });
});
