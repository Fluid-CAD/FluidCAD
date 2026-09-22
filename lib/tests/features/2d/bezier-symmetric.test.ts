// The sketch Mirror tool's bezier form: a reflected `bezier(...)` statement
// held to its source by one point-pair `symmetric(bz.point(i), bz2.point(i),
// axis)` per control point. The curve is a rigid function of its control
// points, so mirroring every control point mirrors the curve exactly — the
// image's 2n params are consumed by the 2n rows, nothing redundant.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, bezier, yAxis } from "../../../core/2d/index.js";
import { coincident, horizontal, fix, distance, symmetric } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Scene } from "../../../rendering/scene.js";

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

describe("bezier mirrored through per-control-point symmetric rows", () => {
  setupOC();

  it("reflects every control point across the axis and leaves the image with no free params", () => {
    let source: unknown;
    let image: unknown;
    const s = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      fix(a.start(), [0, 0]);
      horizontal(a);
      distance(a.start(), a.end(), 40);
      // Two literal control points (own anchors) + one riding the line's end.
      const bz1 = bezier([10, 0], [25, 30], a.end());
      source = bz1;
      // The image, as the tool writes it: reflected guesses, then held.
      const bz2 = bezier([-9, 1], [-24, 29], [-41, 2]);
      image = bz2;
      symmetric(bz1.point(0), bz2.point(0), yAxis());
      symmetric(bz1.point(1), bz2.point(1), yAxis());
      symmetric(a.end(), bz2.point(2), yAxis());
      // Pin the source's own free points so the sketch fully constrains.
      coincident(bz1.point(0), a);
      distance(a.start(), bz1.point(0), 10);
      fix(bz1.point(1), [25, 30]);
    }) as unknown as Sketch;
    const scene = render();

    const src = payloadOf(scene, source);
    const img = payloadOf(scene, image);
    const srcPoints = [src.startPoint, ...src.resolvedPoints] as [number, number][];
    const imgPoints = [img.startPoint, ...img.resolvedPoints] as [number, number][];
    expect(srcPoints).toHaveLength(3);
    expect(imgPoints).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(imgPoints[i][0]).toBeCloseTo(-srcPoints[i][0], 6);
      expect(imgPoints[i][1]).toBeCloseTo(srcPoints[i][1], 6);
    }
    expect(srcPoints[0]).toEqual([expect.closeTo(10, 6), expect.closeTo(0, 6)]);
    expect(srcPoints[2]).toEqual([expect.closeTo(40, 6), expect.closeTo(0, 6)]);

    const sketchPayload = payloadOf(scene, s);
    expect(sketchPayload.solver.outcome).toBe('solved');
    expect(sketchPayload.solver.dof).toBe(0);
    expect(sketchPayload.solver.redundant ?? []).toEqual([]);
  });
});
