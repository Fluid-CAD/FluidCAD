// The sketch Mirror tool's ellipse form: a reflected `ellipse(c, rx, ry,
// rotation)` statement held to its source by one `symmetric(el1, el2,
// axis)` — centers mirror, semi-radii equal, RX axes reflect (5 rows, the
// image's 5 params).

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { ellipse, yAxis } from "../../../core/2d/index.js";
import { fix, radius, symmetric, vertical } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Scene } from "../../../rendering/scene.js";

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

describe("ellipse mirrored through symmetric()", () => {
  setupOC();

  it("reflects the center, keeps the semi-radii and reflects the RX axis, leaving the image with no free params", () => {
    let source: unknown;
    let image: unknown;
    const s = sketch('xy', () => {
      const el1 = ellipse([20, 5], 8, 3, 60);
      source = el1;
      // The image as the tool writes it: reflected guesses, slightly off.
      const el2 = ellipse([-19, 6], 7, 3.5, 115);
      image = el2;
      symmetric(el1, el2, yAxis());
      fix(el1.center(), [25, 8]);
      radius(el1, 9, 'x');
      radius(el1, 4, 'y');
      vertical(el1);
    }) as unknown as Sketch;
    const scene = render();

    const src = payloadOf(scene, source);
    const img = payloadOf(scene, image);
    expect(img.center.x).toBeCloseTo(-src.center.x, 6);
    expect(img.center.y).toBeCloseTo(src.center.y, 6);
    expect(img.center.x).toBeCloseTo(-25, 6);
    expect(img.rx).toBeCloseTo(9, 6);
    expect(img.ry).toBeCloseTo(4, 6);
    // Reflection across x = 0: rotations sum to 180° modulo 180°.
    const wrapped = (src.rotation + img.rotation - 180) / 180;
    expect(Math.abs(wrapped - Math.round(wrapped))).toBeLessThan(1e-6);

    const sketchPayload = payloadOf(scene, s);
    expect(sketchPayload.solver.outcome).toBe('solved');
    expect(sketchPayload.solver.dof).toBe(0);
    expect(sketchPayload.solver.redundant ?? []).toEqual([]);
  });
});
